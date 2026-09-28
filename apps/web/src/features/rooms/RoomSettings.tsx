import { errorMessage } from '@/lib/errors';
import { useEffect, useState } from 'react';
import { DoorOpen, Trash2, UserMinus } from 'lucide-react';
import { api, type Room, type User } from '@/api';
import { Button } from '@/components/ui/button';
import { AppDialog } from '@/components/app-dialog';
import { Input } from '@/components/ui/input';

type MessageReport = { id: string; message_id: string; reporter_name: string; author_name: string; excerpt: string; reason: string };

export default function RoomSettings({
  room,
  user,
  open,
  onOpenChange,
  onChanged,
  onError,
  refreshRevision = 0,
}: {
  room: Room | null;
  user: User | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onChanged: () => void;
  onError: (s: string) => void;
  refreshRevision?: number;
}) {
  const [name, setName] = useState(room?.name ?? ''),
    [members, setMembers] = useState<{ user: User; role: string }[]>([]),
    [reports, setReports] = useState<MessageReport[]>([]),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const owner = room?.owner_id === user?.id;
  useEffect(() => {
    setName(room?.name ?? '');
    setConfirm(false);
    if (open && room)
      api<{ members: { user: User; role: string }[] }>(
        '/rooms/' + room.id + '/members',
      )
        .then((r) => setMembers(r.members))
        .catch((e) => onError(e.message));
    if (open && room && room.owner_id === user?.id && room.kind !== 'direct')
      api<{ reports: MessageReport[] }>('/rooms/' + room.id + '/reports')
        .then((result) => setReports(result.reports ?? []))
        .catch((error) => onError(errorMessage(error)));
    else setReports([]);
  }, [open, room?.id, room?.name, room?.owner_id, room?.kind, user?.id, refreshRevision, onError]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function removeReportedMessage(report: MessageReport) {
    if (!room) return;
    setBusy(true);
    try {
      await api('/rooms/' + room.id + '/messages/' + report.message_id + '/moderation', { reason: `Report: ${report.reason}`.slice(0, 500) }, 'DELETE');
      setReports((current) => current.filter((item) => item.message_id !== report.message_id));
      onChanged();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function dismissReport(report: MessageReport) {
    if (!room) return;
    setBusy(true);
    try {
      await api('/rooms/' + room.id + '/reports/' + report.id + '/dismiss', {}, 'POST');
      setReports((current) => current.filter((item) => item.id !== report.id));
      onChanged();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Room settings"
      description="Keep this little corner just how you like it."
    >
      {room && user && (
        <div className="mt-6 flex flex-col gap-5">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              action(async () => {
                await api('/rooms/' + room.id, { name }, 'PATCH');
                onOpenChange(false);
              });
            }}
          >
            <label className="block text-xs font-medium text-foreground/80">
              Room name
              <Input
                className="mt-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                required
                disabled={!owner}
              />
            </label>
            {owner && (
              <Button type="submit" disabled={busy}>
                Save name
              </Button>
            )}
          </form>
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">People in this room</h3>
            {members.map((m) => (
              <div
                className="flex items-center justify-between gap-2.5 border-b py-2 text-xs"
                key={m.user.id}
              >
                <span className="min-w-0 flex-1">
                  <strong className="block">{m.user.name}</strong>
                  <small className="mt-1 block text-[0.7rem] text-muted-foreground">
                    {m.role === 'owner' ? 'Room owner' : 'Member'}
                  </small>
                </span>
                {owner && m.user.id !== user.id && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={'Remove ' + m.user.name}
                    onClick={() =>
                      action(async () => {
                        await api(
                          '/rooms/' + room.id + '/members/' + m.user.id,
                          undefined,
                          'DELETE',
                        );
                        setMembers((list) =>
                          list.filter((x) => x.user.id !== m.user.id),
                        );
                      })
                    }
                  >
                    <UserMinus size={16} />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {owner && reports.length > 0 && (
            <div className="flex flex-col gap-2 border-t pt-4">
              <h3 className="text-sm font-semibold">Message reports</h3>
              {reports.map((report) => (
                <div key={report.id} className="rounded-lg border p-3 text-xs">
                  <p><strong>{report.reporter_name}</strong> reported a message from {report.author_name}</p>
                  <p className="mt-1 truncate text-muted-foreground">{report.excerpt}</p>
                  <p className="mt-1">{report.reason}</p>
                  <Button className="mt-2" size="sm" variant="destructive" disabled={busy} onClick={() => void removeReportedMessage(report)}>Remove message</Button>
                  <Button className="mt-2" size="sm" variant="ghost" disabled={busy} onClick={() => void dismissReport(report)}>Dismiss report</Button>
                </div>
              ))}
            </div>
          )}
          {confirm ? (
            <div className="rounded-xl border border-destructive/40 p-4">
              <p className="mb-3.5 text-xs leading-6 text-destructive">
                {owner
                  ? 'Delete this room and its chat history? This cannot be undone.'
                  : 'Leave this room? A friend will need to invite you back.'}
              </p>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api(
                      owner
                        ? '/rooms/' + room.id
                        : '/rooms/' + room.id + '/members/' + user.id,
                      undefined,
                      'DELETE',
                    );
                    onOpenChange(false);
                  })
                }
              >
                {owner ? 'Delete room permanently' : 'Leave room'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              {owner ? <Trash2 size={16} /> : <DoorOpen size={16} />}{' '}
              {owner ? 'Delete room' : 'Leave room'}
            </Button>
          )}
        </div>
      )}
    </AppDialog>
  );
}
