import { useRef, useState, useSyncExternalStore } from 'react';
import { Check, Hash, MessageSquare, Phone, UserPlus } from 'lucide-react';
import { api, type Room, type User } from '@/api';
import { Avatar } from '@/components/avatar';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';
import { callPresenceSnapshot, subscribeCallPresence } from '@/features/call/useCallPresence';
import { CustomStatusText } from './CustomStatus';
import { receiveCustomStatus } from './customStatusStore';
import { profileSnapshot, subscribeProfiles } from './profileStore';
import { presenceLabels } from './presenceStore';
import { createProfileReader, type ProfileResponse } from './profileReader';
let target: { userId: string; ownerId: string; revision: number } | undefined;
let ownerId: string | undefined;
let hostIdentity = 0;
let revision = 0;
let returnFocus: HTMLElement | null = null;
const listeners = new Set<() => void>();
const snapshot = () => target;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function announce() { for (const listener of listeners) listener(); }
export function openUserProfile(userId: string) {
  if (!userId || !ownerId) return;
  if (!target) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  target = { userId, ownerId, revision: ++revision }; announce();
}
function closeProfile() {
  target = undefined; announce();
  const element = returnFocus; returnFocus = null;
  requestAnimationFrame(() => { if (element?.isConnected) element.focus(); });
}
type HostProps = { user: User; onOpenRoom: (room: Room) => void; onCall?: (room: Room) => void; onEditProfile?: () => void; onError?: (error: string) => void };
export function ProfileDialogHost(props: HostProps) {
  const selected = useSyncExternalStore(subscribe, snapshot);
  useMountEffect(() => {
    const identity = ++hostIdentity;
    ownerId = props.user.id;
    return () => {
      if (identity !== hostIdentity) return;
      ownerId = undefined; target = undefined; returnFocus = null; announce();
    };
  });
  return selected?.ownerId === props.user.id ? <ProfileDialog key={`${props.user.id}:${selected.userId}:${selected.revision}`} {...props} userId={selected.userId} /> : null;
}
function ProfileDialog({ userId, user, onOpenRoom, onCall, onEditProfile }: HostProps & { userId: string }) {
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  const profiles = useSyncExternalStore(subscribeProfiles, profileSnapshot);
  const contactPresence = useSyncExternalStore(subscribeCallPresence, callPresenceSnapshot);
  const [reader] = useState(() => createProfileReader(userId, (result) => {
    if (result.user.custom_status) receiveCustomStatus({ user_id: userId, status: result.user.custom_status, version: result.user.status_version ?? 0 });
    setData(result); setError('');
  }, (message, denied) => { if (denied) setData(null); setError(message); }));
  useMountEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; });
  useMountEffect(() => {
    let previous = callPresenceSnapshot();
    return subscribeCallPresence(() => {
      const next = callPresenceSnapshot();
      const changed = next.userId === user.id && (next.friendsRevision !== previous.friendsRevision || next.roomsRevision !== previous.roomsRevision || next.syncRevision !== previous.syncRevision);
      previous = next;
      if (!changed) return;
      reader.invalidate(); setData(null); setError(''); setReload((value) => value + 1);
    });
  });
  async function action(operation: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('');
    try { await operation(controller.signal); }
    catch (failure) { if (active.current && !controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (request.current === controller) request.current = null; if (active.current) setBusy(false); }
  }
  async function openConversation(call = false) {
    await action(async (signal) => {
      const result = await api<{ room: Room }>('/rooms/direct', { user_id: userId }, undefined, signal);
      if (!active.current || signal.aborted) return;
      closeProfile();
      if (call && onCall) onCall(result.room); else onOpenRoom(result.room);
    });
  }
  const cached = profiles[userId];
  const person = data && cached && (cached.profile_version ?? 0) > (data.user.profile_version ?? 0) ? cached : data?.user;
  const presence = contactPresence.contactStatuses[userId] ?? data?.presence ?? 'offline';
  return <AppDialog open onOpenChange={(open) => { if (!open) closeProfile(); }} title={person?.name ?? 'Profile'} description="Profile information shared with you in BetterComms." className="flex max-h-[85dvh] flex-col gap-4 sm:max-w-lg">
    <ProfileLoader key={reload} reader={reader} />
    {person ? <div className="min-h-0 overflow-y-auto space-y-5 pr-1">
      <div className="flex items-center gap-4"><Avatar name={person.name} id={person.id} src={person.avatar_url} size="lg" className="size-20" presence={presence === 'idle' ? 'away' : presence} /><div className="min-w-0"><h2 className="truncate text-lg font-semibold">{person.name}</h2>{person.username && <p className="truncate text-sm text-muted-foreground">@{person.username}</p>}<p className="mt-1 text-xs text-muted-foreground">{presenceLabels[presence]}</p><CustomStatusText userId={person.id} status={person.custom_status} version={person.status_version} /></div></div>
      {person.bio && <div><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">About</h3><p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">{person.bio}</p></div>}
      <div className="flex flex-wrap gap-2">
        {data?.relationship === 'friend' && <><Button size="sm" disabled={busy} onClick={() => { void openConversation(); }}><MessageSquare size={15} /> Message</Button>{onCall && <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void openConversation(true); }}><Phone size={15} /> Call</Button>}</>}
        {data?.relationship === 'self' && onEditProfile && <Button size="sm" variant="secondary" onClick={() => { closeProfile(); onEditProfile(); }}>Edit profile</Button>}
        {data?.relationship === 'shared_room' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void action(async (signal) => { await api('/friends/requests', { user_id: userId }, undefined, signal); if (!signal.aborted && active.current) await reader.load(signal); }); }}><UserPlus size={15} /> Add friend</Button>}
        {data?.relationship === 'incoming_request' && data.friend_request_id && <Button size="sm" disabled={busy} onClick={() => { void action(async (signal) => { await api(`/friends/requests/${data.friend_request_id}/accept`, {}, undefined, signal); if (!signal.aborted && active.current) await reader.load(signal); }); }}><Check size={15} /> Accept friend request</Button>}
        {data?.relationship === 'outgoing_request' && data.friend_request_id && <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void action(async (signal) => { await api(`/friends/requests/${data.friend_request_id}/decline`, {}, 'POST', signal); if (!signal.aborted && active.current) closeProfile(); }); }}>Cancel friend request</Button>}
      </div>
      {Boolean(data?.shared_rooms.length) && <section className="space-y-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Shared conversations</h3>{data!.shared_rooms.map((room) => <button key={room.id} className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" type="button" onClick={() => { closeProfile(); onOpenRoom(room); }}><Hash size={14} className="shrink-0 text-muted-foreground" /><span className="truncate">{room.display_name || room.name}</span></button>)}</section>}
      {Boolean(data?.mutual_friends.length) && <section className="space-y-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Mutual friends</h3><div className="flex flex-wrap gap-2">{data!.mutual_friends.map((friend) => <button key={friend.id} className="flex max-w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" type="button" aria-label={`View profile of ${friend.name}`} onClick={() => openUserProfile(friend.id)}><Avatar name={friend.name} id={friend.id} src={friend.avatar_url} /><span className="truncate">{friend.name}</span></button>)}</div></section>}
      {data?.relationship === 'self' && <p className="text-xs text-muted-foreground">This is the information other people can see. Your email is private.</p>}
    </div> : !error && <p role="status" className="py-8 text-center text-sm text-muted-foreground">Loading profile…</p>}
    {error && <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" disabled={busy} onClick={() => setReload((value) => value + 1)}>Retry profile</Button></div>}
  </AppDialog>;
}
function ProfileLoader({ reader }: { reader: ReturnType<typeof createProfileReader> }) {
  useMountEffect(() => {
    reader.start(); void reader.load();
    return () => reader.close();
  });
  return null;
}
