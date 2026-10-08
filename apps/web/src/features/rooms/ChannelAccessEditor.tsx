import { useState } from 'react';
import { api, type Room } from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';
import {
  channelPermissions,
  setChannelOverride,
  type ChannelAccess,
  type CustomRole,
  type PermissionValue,
} from './channelPermissions';

export default function ChannelAccessEditor({
  communityId,
  room,
  roles,
  onClose,
  onChanged,
}: {
  communityId: string;
  room: Room;
  roles: CustomRole[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [access, setAccess] = useState<ChannelAccess | null>(null);
  const [subject, setSubject] = useState('everyone');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signalForRequest = useLifetimeSignal();
  const path = `/communities/${communityId}/channels/${room.id}/permissions`;
  async function load() {
    const signal = signalForRequest();
    setError('');
    try {
      const result = await api<{ access: ChannelAccess }>(
        path,
        undefined,
        'GET',
        signal,
      );
      if (!signal.aborted) setAccess(result.access);
    } catch (failure) {
      if (!signal.aborted) setError(errorMessage(failure));
    }
  }
  useMountEffect(() => {
    void load();
  });
  async function save() {
    if (!access || busy) return;
    const signal = signalForRequest();
    setBusy(true);
    setError('');
    try {
      await api(
        path,
        { is_private: access.is_private, overrides: access.overrides },
        'PUT',
        signal,
      );
      if (!signal.aborted) {
        await onChanged();
        onClose();
      }
    } catch (failure) {
      if (!signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  const subjects = [
    { id: 'everyone', name: 'Everyone' },
    { id: 'member', name: 'Members (built-in)' },
    { id: 'moderator', name: 'Moderators (built-in)' },
    ...roles.map((role) => ({ id: role.id, name: role.name })),
  ];
  const override = access?.overrides.find(
    (item) => item.subject_key === subject,
  );
  return (
    <AppDialog
      open
      title={`Access to #${room.name}`}
      description="Control who can view, post and join voice in this channel."
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <div className="mt-5 space-y-5">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
            {!access && (
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            )}
          </p>
        )}
        {!access && !error && (
          <p className="text-sm text-muted-foreground">
            Loading channel permissions…
          </p>
        )}
        {access && (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="flex items-start gap-3 rounded-lg border p-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={access.is_private}
                disabled={busy}
                onChange={(event) =>
                  setAccess({ ...access, is_private: event.target.checked })
                }
              />
              <span>
                <strong className="block text-sm">Private channel</strong>
                <small className="block text-xs leading-5 text-muted-foreground">
                  Only roles with an explicit View channel allowance, plus the
                  owner and admins, can find this channel.
                </small>
              </span>
            </label>
            <label className="block space-y-2 text-sm">
              Permissions for
              <select
                className="h-10 w-full rounded-md border bg-background px-3"
                aria-label="Permissions for role"
                value={subject}
                disabled={busy}
                onChange={(event) => setSubject(event.target.value)}
              >
                {subjects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <fieldset disabled={busy} className="space-y-3">
              <legend className="sr-only">Channel permission overrides</legend>
              {channelPermissions.map((permission) => (
                <label
                  key={permission.key}
                  className="flex items-center justify-between gap-4 text-sm"
                >
                  <span>
                    {permission.label}
                    <small className="block text-xs leading-5 text-muted-foreground">
                      {permission.description}
                    </small>
                  </span>
                  <select
                    className="h-9 rounded-md border bg-background px-2"
                    aria-label={`${permission.label} override`}
                    value={override?.permissions[permission.key] ?? 'inherit'}
                    onChange={(event) =>
                      setAccess({
                        ...access,
                        overrides: setChannelOverride(
                          access.overrides,
                          subject,
                          permission.key,
                          event.target.value as PermissionValue | 'inherit',
                        ),
                      })
                    }
                  >
                    <option value="inherit">Inherit</option>
                    <option value="allow">Allow</option>
                    <option value="deny">Deny</option>
                  </select>
                </label>
              ))}
            </fieldset>
            <div className="rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
              Denies win across all matching channel overrides, then explicit
              allowances, then role defaults. The owner and admins retain
              access.{' '}
              {room.channel_type === 'announcement'
                ? 'Announcements always disable voice and reserve posting for owners/admins.'
                : 'Voice stays in this channel alongside its messages.'}
            </div>
            {access.overrides.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold">Configured overrides</h4>
                <ul className="space-y-2 text-xs">
                  {access.overrides.map((item) => (
                    <li
                      key={item.subject_key}
                      className="rounded-lg border p-3"
                    >
                      <strong className="block">
                        {subjects.find((entry) => entry.id === item.subject_key)
                          ?.name ?? 'Removed role'}
                      </strong>
                      <span className="text-muted-foreground">
                        {channelPermissions
                          .flatMap((permission) =>
                            item.permissions[permission.key]
                              ? [
                                  `${permission.label}: ${item.permissions[permission.key]}`,
                                ]
                              : [],
                          )
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!!access.effective_members?.length && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold">
                  Current effective access
                </h4>
                <p className="text-xs leading-5 text-muted-foreground">
                  Saved role and channel permissions. Save changes to
                  recalculate them; timeouts and slow mode also apply.
                </p>
                <div className="max-h-48 overflow-auto rounded-lg border">
                  <table className="w-full text-left text-xs">
                    <caption className="sr-only">
                      Current saved channel permissions for each member
                    </caption>
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th scope="col" className="px-3 py-2">
                          Member
                        </th>
                        {channelPermissions.map((permission) => (
                          <th
                            key={permission.key}
                            scope="col"
                            className="px-2 py-2"
                          >
                            {permission.key === 'read'
                              ? 'View'
                              : permission.key === 'post'
                                ? 'Post'
                                : permission.key === 'join_voice'
                                  ? 'Voice'
                                  : 'Pin'}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {access.effective_members.map((member) => (
                        <tr key={member.user_id} className="border-t">
                          <th
                            scope="row"
                            className="max-w-36 truncate px-3 py-2 font-medium"
                            title={`${member.name} · ${member.role}`}
                          >
                            {member.name}
                          </th>
                          {channelPermissions.map((permission) => (
                            <td
                              key={permission.key}
                              className={`px-2 py-2 ${member[permission.key] ? 'text-foreground' : 'text-muted-foreground'}`}
                            >
                              {member[permission.key] ? 'Allow' : 'Deny'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save channel access'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </AppDialog>
  );
}
