import { useState } from 'react';
import { api, type Room, type User } from '@/api';
import { Avatar } from '@/components/avatar';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';

export default function GroupConversationDialog({ onClose, onCreated }: {
  onClose: () => void; onCreated: (room: Room) => Promise<void>;
}) {
  const [friends, setFriends] = useState<User[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signalForRequest = useLifetimeSignal();
  useMountEffect(() => {
    const controller = new AbortController();
    void api<{ friends: User[] }>('/friends', undefined, 'GET', controller.signal)
      .then((result) => { if (!controller.signal.aborted) setFriends(result.friends ?? []); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  });
  async function create() {
    const signal = signalForRequest();
    setBusy(true); setError('');
    try {
      const { room } = await api<{ room: Room }>('/rooms/group', { name: name.trim(), user_ids: selected }, 'POST', signal);
      signal.throwIfAborted();
      await onCreated(room);
      signal.throwIfAborted();
      onClose();
    } catch (reason) { if (!signal.aborted) setError(errorMessage(reason)); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return (
    <AppDialog open className="max-h-[calc(100dvh-2rem)] overflow-y-auto" onOpenChange={(open) => { if (!open && !busy) onClose(); }} title="New group message" description="A private conversation with up to ten people, including you. Only accepted friends can be added.">
      <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label className="block text-sm">Group name<Input autoFocus className="mt-2" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required disabled={busy} placeholder="Friday night crew" /></label>
        <fieldset disabled={busy}>
          <legend className="mb-2 text-sm font-medium">Choose friends · {selected.length}/9</legend>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border p-2">
            {loading ? <p className="p-2 text-sm text-muted-foreground">Loading friends…</p> : friends.length === 0 ? <p className="p-2 text-sm text-muted-foreground">Add and accept a friend before starting a group.</p> : friends.map((friend) => (
              <label key={friend.id} className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-muted">
                <input type="checkbox" aria-label={friend.name} checked={selected.includes(friend.id)} disabled={!selected.includes(friend.id) && selected.length >= 9} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, friend.id] : ids.filter((id) => id !== friend.id))} />
                <Avatar name={friend.name} id={friend.id} src={friend.avatar_url} />
                <span className="min-w-0 truncate text-sm">{friend.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || loading || selected.length === 0 || !name.trim()}>{busy ? 'Creating…' : 'Create group'}</Button></div>
      </form>
    </AppDialog>
  );
}
