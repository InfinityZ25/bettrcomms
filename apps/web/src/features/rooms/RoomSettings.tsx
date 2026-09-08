import { useEffect, useState } from 'react';
import { DoorOpen, Trash2, UserMinus } from 'lucide-react';
import { api, type Room, type User } from '@/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
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
  }, [open, room?.id, refreshRevision]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
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
              <input
                className="mt-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                required
                disabled={!owner}
              />
            </label>
            {owner && <Button disabled={busy}>Save name</Button>}
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
          {confirm ? (
            <div className="rounded-xl border border-destructive/40 p-4">
              <p className="mb-3.5 text-xs leading-6 text-destructive">
                {owner
                  ? 'Delete this room and its chat history? This cannot be undone.'
                  : 'Leave this room? A friend will need to invite you back.'}
              </p>
              <Button
                variant="danger"
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
    </Dialog>
  );
}
