import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { errorMessage } from '@/lib/errors';
import {
  channelPermissions,
  type ChannelPermission,
  type CustomRole,
} from './channelPermissions';

export default function CustomRoleSettings({
  communityId,
  roles,
  onChanged,
}: {
  communityId: string;
  roles: CustomRole[];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<CustomRole | 'new' | null>(null);
  const [removing, setRemoving] = useState<CustomRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signalForRequest = useLifetimeSignal();
  async function remove() {
    if (!removing || busy) return;
    const signal = signalForRequest();
    setBusy(true);
    setError('');
    try {
      await api(
        `/communities/${communityId}/roles/${removing.id}`,
        undefined,
        'DELETE',
        signal,
      );
      if (!signal.aborted) {
        setRemoving(null);
        await onChanged();
      }
    } catch (failure) {
      if (!signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="space-y-4" aria-label="Custom room roles">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">Custom roles</h3>
          <p className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">
            Give your group recognizable roles and default channel permissions.
            Owner, admin and moderator authority stays with the built-in roles.
          </p>
        </div>
        <Button
          size="sm"
          disabled={roles.length >= 50 || busy}
          onClick={() => setEditing('new')}
        >
          <Plus size={15} />
          Create role
        </Button>
      </div>
      {roles.length ? (
        <ul className="divide-y rounded-lg border px-3">
          {roles.map((role) => (
            <li key={role.id} className="flex items-center gap-3 py-3">
              <span
                className="size-3 shrink-0 rounded-full"
                style={{ backgroundColor: role.color }}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {role.name}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit ${role.name} role`}
                onClick={() => setEditing(role)}
              >
                <Pencil size={15} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${role.name} role`}
                onClick={() => setRemoving(role)}
              >
                <Trash2 size={15} />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          Create a role for your gaming squad, guests or regulars, then assign
          it in Members.
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        Private channels require an explicit View channel allowance in that
        channel's access settings. A role cannot grant room administration.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {editing && (
        <RoleEditor
          key={editing === 'new' ? 'new' : editing.id}
          role={editing === 'new' ? undefined : editing}
          communityId={communityId}
          onClose={() => setEditing(null)}
          onChanged={onChanged}
        />
      )}
      {removing && (
        <AppDialog
          open
          title={`Delete ${removing.name}?`}
          description="Members lose this role. Its channel overrides are removed and access is recalculated immediately."
          onOpenChange={(open) => {
            if (!open && !busy) setRemoving(null);
          }}
        >
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Deleting…' : 'Delete role'}
            </Button>
          </div>
        </AppDialog>
      )}
    </section>
  );
}

function RoleEditor({
  role,
  communityId,
  onClose,
  onChanged,
}: {
  role?: CustomRole;
  communityId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [color, setColor] = useState(role?.color ?? '#64748b');
  const [permissions, setPermissions] = useState<CustomRole['permissions']>({
    ...role?.permissions,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signalForRequest = useLifetimeSignal();
  function permissionChanged(key: ChannelPermission, value: string) {
    setPermissions((current) => {
      const next = { ...current };
      if (value === 'inherit') delete next[key];
      else next[key] = value === 'allow';
      return next;
    });
  }
  async function save() {
    if (busy) return;
    const signal = signalForRequest();
    setBusy(true);
    setError('');
    try {
      await api(
        `/communities/${communityId}/roles${role ? `/${role.id}` : ''}`,
        { name: name.trim(), color, permissions },
        role ? 'PATCH' : 'POST',
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
      title={role ? `Edit ${role.name} role` : 'Create a role'}
      description="Default restrictions apply to members with this role. Channel overrides can refine these defaults."
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex gap-3">
          <label className="min-w-0 flex-1 space-y-2 text-sm">
            Role name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={60}
              disabled={busy}
              autoFocus
            />
          </label>
          <label className="space-y-2 text-sm">
            Color
            <input
              type="color"
              className="block h-9 w-14 cursor-pointer rounded-md border bg-background p-1"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              disabled={busy}
            />
          </label>
        </div>
        <fieldset className="space-y-3" disabled={busy}>
          <legend className="mb-2 text-sm font-semibold">
            Default channel permissions
          </legend>
          {channelPermissions.map((permission) => (
            <label
              key={permission.key}
              className="flex items-center justify-between gap-4 text-sm"
            >
              <span>
                {permission.label}
                <small className="block text-xs text-muted-foreground">
                  {permission.description}
                </small>
              </span>
              <select
                aria-label={`Default ${permission.label.toLowerCase()}`}
                className="h-9 rounded-md border bg-background px-2"
                value={
                  permissions[permission.key] === undefined
                    ? 'inherit'
                    : permissions[permission.key]
                      ? 'allow'
                      : 'deny'
                }
                onChange={(event) =>
                  permissionChanged(permission.key, event.target.value)
                }
              >
                <option value="inherit">Room default</option>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </label>
          ))}
        </fieldset>
        <p className="text-xs leading-5 text-muted-foreground">
          When multiple custom roles apply, a denied default wins. Allowing View
          channel preserves public access; private channels still need their own
          allowance. Announcements always reserve posting for owners/admins and
          disable voice.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save role'}
          </Button>
        </div>
      </form>
    </AppDialog>
  );
}
