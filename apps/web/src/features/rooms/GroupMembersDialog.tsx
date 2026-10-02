import { useState } from 'react';
import { api, type Room, type User } from '@/api';
import { Avatar } from '@/components/avatar';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';
import { callPresenceSnapshot, subscribeCallPresence } from '@/features/call/useCallPresence';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';

type Member = { user: User; role: string };
export default function GroupMembersDialog({ room, user, onClose, onChanged }: {
  room: Room; user: User; onClose: () => void; onChanged: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [friends, setFriends] = useState<User[]>([]);
  const [name, setName] = useState(room.name);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<User | null>(null);
  const [leaving, setLeaving] = useState(false);
  const owner = room.owner_id === user.id;
  const signalForRequest = useLifetimeSignal();
  useMountEffect(() => {
    let controller: AbortController | undefined;
    let revision = '';
    const load = () => {
      const current = callPresenceSnapshot();
      const next = `${current.roomsRevision}:${current.syncRevision}:${current.friendsRevision}`;
      if (controller && next === revision) return;
      revision = next;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      void Promise.all([
      api<{ members: Member[] }>(`/rooms/${room.id}/members`, undefined, 'GET', request.signal),
      owner ? api<{ friends: User[] }>('/friends', undefined, 'GET', request.signal) : Promise.resolve({ friends: [] }),
    ]).then(([people, accepted]) => {
      if (!request.signal.aborted) { setMembers(people.members); setFriends(accepted.friends); setError(''); }
    }).catch((reason) => { if (!request.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    };
    load();
    const stop = subscribeCallPresence(load);
    return () => { stop(); controller?.abort(); };
  });
  async function action<T>(task: (signal: AbortSignal) => Promise<T>): Promise<{ value: T } | undefined> {
    const signal = signalForRequest();
    setBusy(true); setError('');
    try { const value = await task(signal); if (!signal.aborted) { onChanged(); return { value }; } }
    catch (reason) { if (!signal.aborted) setError(errorMessage(reason)); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  async function addFriend(friend: User) {
    const result = await action(async (signal) => {
      await api(`/rooms/${room.id}/members`, { user_id: friend.id }, 'POST', signal);
      return api<{ members: Member[] }>(`/rooms/${room.id}/members`, undefined, 'GET', signal);
    });
    if (result && !signalForRequest().aborted) setMembers(result.value.members);
  }
  async function removeMember(target: User) {
    const result = await action((signal) => api(`/rooms/${room.id}/members/${target.id}`, undefined, 'DELETE', signal));
    if (!result || signalForRequest().aborted) return;
    setMembers((current) => current.filter((member) => member.user.id !== target.id));
    setRemoving(null);
  }
  async function leave() {
    const result = await action((signal) => api(`/rooms/${room.id}/members/${user.id}`, undefined, 'DELETE', signal));
    if (result && !signalForRequest().aborted) onClose();
  }
  const candidates = friends.filter((friend) => !members.some((member) => member.user.id === friend.id));
  return (
    <AppDialog open className="max-h-[calc(100dvh-2rem)] overflow-y-auto" onOpenChange={(open) => { if (!open && !busy) onClose(); }} title="Group info" description="Members can read this conversation's history and join its calls.">
      <div className="mt-5 space-y-5">
        <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void action(async (signal) => { await api(`/rooms/${room.id}`, { name: name.trim() }, 'PATCH', signal); }); }}>
          <label className="min-w-0 flex-1 text-sm">Group name<Input className="mt-2" value={name} maxLength={80} required disabled={!owner || busy} onChange={(event) => setName(event.target.value)} /></label>
          {owner && <Button type="submit" disabled={busy || !name.trim() || name.trim() === room.name}>Save</Button>}
        </form>
        {name !== room.name && <p className="text-xs text-muted-foreground">Your draft is unsaved. <button className="underline" disabled={busy} onClick={() => setName(room.name)}>Use the current group name</button></p>}
        <section className="space-y-2"><h3 className="text-sm font-medium">Members · {members.length}/10</h3>
          {loading && <p className="text-sm text-muted-foreground">Loading members…</p>}
          <div className="max-h-52 overflow-y-auto">{members.map((member) => (
            <div key={member.user.id} className="flex items-center gap-3 border-b py-2">
              <Avatar name={member.user.name} id={member.user.id} src={member.user.avatar_url} />
              <span className="min-w-0 flex-1 text-sm"><strong className="block truncate">{member.user.name}</strong><small className="text-muted-foreground">{member.role === 'owner' ? 'Group owner' : 'Member'}</small></span>
              {owner && member.user.id !== user.id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(member.user)}>Remove</Button>}
            </div>
          ))}</div>
        </section>
        {owner && !loading && members.length < 10 && <section className="space-y-2"><h3 className="text-sm font-medium">Add a friend</h3>
          <div className="max-h-36 overflow-y-auto">{candidates.length ? candidates.map((friend) => <div key={friend.id} className="flex items-center justify-between gap-2 py-1.5"><span className="truncate text-sm">{friend.name}</span><Button size="sm" variant="secondary" disabled={busy} aria-label={`Add ${friend.name} to group`} onClick={() => void addFriend(friend)}>Add</Button></div>) : <p className="text-sm text-muted-foreground">All your accepted friends are already here.</p>}</div>
        </section>}
        {removing && <div className="rounded-lg border p-3 text-sm"><p>Remove {removing.name}? They will lose access to the conversation and call.</p><div className="mt-3 flex gap-2"><Button variant="destructive" disabled={busy} onClick={() => void removeMember(removing)}>Confirm removal</Button><Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button></div></div>}
        {leaving ? <div className="rounded-lg border p-3 text-sm"><p>Leave this group? {owner ? 'Ownership passes to the next member. ' : ''}A friend will need to add you again.</p><div className="mt-3 flex gap-2"><Button variant="destructive" disabled={busy} onClick={() => void leave()}>Confirm leave</Button><Button variant="ghost" disabled={busy} onClick={() => setLeaving(false)}>Cancel</Button></div></div> : <Button variant="ghost" disabled={busy} onClick={() => setLeaving(true)}>Leave group</Button>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </AppDialog>
  );
}
