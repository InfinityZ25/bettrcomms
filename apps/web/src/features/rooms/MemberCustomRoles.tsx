import { useMemo, useState } from 'react';
import { api, type RoomMember } from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { errorMessage } from '@/lib/errors';
import type { CustomRole } from './channelPermissions';

export default function MemberCustomRoles({
  communityId,
  member,
  roles,
  onChanged,
}: {
  communityId: string;
  member: RoomMember;
  roles: CustomRole[];
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Custom roles for ${member.user.name}`}
        onClick={() => setOpen(true)}
      >
        Custom roles
      </Button>
      {open && (
        <MemberRoleEditor
          key={member.custom_role_ids?.join(':') ?? 'none'}
          communityId={communityId}
          member={member}
          roles={roles}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}
function MemberRoleEditor({
  communityId,
  member,
  roles,
  onClose,
  onChanged,
}: {
  communityId: string;
  member: RoomMember;
  roles: CustomRole[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(member.custom_role_ids ?? []);
  const selectedRoles = useMemo(() => new Set(selected), [selected]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signalForRequest = useLifetimeSignal();
  async function save() {
    if (busy) return;
    const signal = signalForRequest();
    setBusy(true);
    setError('');
    try {
      await api(
        `/communities/${communityId}/members/${member.user.id}/custom-roles`,
        { role_ids: selected },
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
  return (
    <AppDialog
      open
      title={`Roles for ${member.user.name}`}
      description="Custom roles add identity and channel permissions. Their built-in room role stays the same."
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset
          disabled={busy}
          className="max-h-72 space-y-2 overflow-y-auto"
        >
          <legend className="sr-only">Assigned custom roles</legend>
          {roles.length ? (
            roles.map((role) => (
              <label
                key={role.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selectedRoles.has(role.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, role.id]
                        : current.filter((id) => id !== role.id),
                    )
                  }
                />
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: role.color }}
                />
                {role.name}
              </label>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              Create a custom role in Roles first.
            </p>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save member roles'}
          </Button>
        </div>
      </form>
    </AppDialog>
  );
}
