import { useState, useSyncExternalStore } from 'react';
import { AtSign, Check, Inbox, MessageSquare, RefreshCw, Reply, UserPlus, X } from 'lucide-react';
import { api, type Message, type Room, type User } from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { callPresenceSnapshot, subscribeCallPresence } from '@/features/call/useCallPresence';
import { openUserProfile } from '@/features/settings/ProfileDialog';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import { formatMessagePreview } from './messageFormatting';
import { createActivityFeed, type ActivityFilter, type ActivityItem } from './activityFeed';

const filters: { id: ActivityFilter; label: string }[] = [
  { id: 'all', label: 'All activity' }, { id: 'mentions', label: 'Mentions' },
  { id: 'replies', label: 'Replies' }, { id: 'requests', label: 'Requests' },
];
const labels = { mention: 'Mentioned you', reply: 'Replied to you', friend_request: 'Friend request', dm_request: 'Message request' };
const icons = { mention: AtSign, reply: Reply, friend_request: UserPlus, dm_request: MessageSquare };

export default function ActivityCenter({ user, rooms, onClose, onOpenMessage, onOpenRoom }: {
  user: User; rooms: Room[]; onClose: () => void;
  onOpenMessage: (room: Room, message: Message) => void;
  onOpenRoom: (room: Room) => void;
}) {
  const [feed] = useState(createActivityFeed);
  const state = useSyncExternalStore(feed.subscribe, feed.snapshot);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const lifetime = useLifetimeSignal();
  useMountEffect(() => {
    feed.start();
    void feed.load();
    let previous = callPresenceSnapshot();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribeCallPresence(() => {
      const next = callPresenceSnapshot();
      if (next.userId !== user.id) return;
      const changed = next.activityRevision !== previous.activityRevision
        || next.syncRevision !== previous.syncRevision || next.friendsRevision !== previous.friendsRevision
        || next.roomsRevision !== previous.roomsRevision;
      previous = next;
      if (!changed || timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; void feed.load(); }, 250);
    });
    return () => { off(); if (timer !== undefined) clearTimeout(timer); feed.close(); };
  });
  async function answer(item: ActivityItem, accept: boolean) {
    if (busy) return;
    setBusy(item.id);
    setActionError('');
    try {
      const signal = lifetime();
      if (item.friend_request) {
        const route = `/friends/requests/${item.friend_request.id}/${accept ? 'accept' : 'decline'}`;
        await api(route, {}, 'POST', signal);
      } else if (item.dm_request) {
        const result = await api<{ room?: Room }>(`/dm-requests/${item.dm_request.id}/${accept ? 'accept' : 'decline'}`, {}, 'POST', signal);
        if (accept && result.room && !signal.aborted) { onClose(); onOpenRoom(result.room); }
      }
      if (!signal.aborted) await feed.load();
    } catch (error) {
      if (!lifetime().aborted) setActionError(error instanceof Error ? error.message : 'Could not answer this request.');
    } finally { if (!lifetime().aborted) setBusy(''); }
  }
  return <AppDialog open onOpenChange={(open) => { if (!open) onClose(); }} title="Activity" description="Your mentions, replies and pending requests. Opening a message takes you to its conversation." className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
    <div className="flex flex-wrap gap-1" role="group" aria-label="Activity filters">
      {filters.map((filter) => <Button key={filter.id} variant={state.filter === filter.id ? 'secondary' : 'ghost'} size="sm" className="min-h-9 phone:min-h-11" aria-pressed={state.filter === filter.id} onClick={() => feed.choose(filter.id)}>{filter.label}</Button>)}
      <Button variant="ghost" size="icon-sm" className="ml-auto phone:size-11" aria-label="Refresh activity" disabled={state.loading} onClick={() => void feed.load()}><RefreshCw size={16} /></Button>
    </div>
    {(state.error || actionError) && <p role="alert" className="text-sm text-destructive">{state.error || actionError}<Button variant="ghost" size="sm" onClick={() => { setActionError(''); void feed.load(); }}>Retry</Button></p>}
    <div className="min-h-0 overflow-y-auto overscroll-contain" aria-label="Activity results" aria-busy={state.loading}>
      {!state.items.length && !state.error && <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground"><Inbox size={28} /><p role="status">{state.loading ? 'Loading activity…' : 'You are all caught up here.'}</p></div>}
      <ul className="space-y-2">
        {state.items.map((item) => {
          const person = item.message?.author ?? item.friend_request?.sender;
          const personId = person?.id ?? item.dm_request?.sender_id;
          const name = person?.name ?? item.dm_request?.sender_name ?? 'Member';
          const room = rooms.find((candidate) => candidate.id === item.room_id);
          const Icon = icons[item.kind];
          return <li key={item.id} className={`rounded-xl border p-3 ${item.read ? 'bg-muted/20' : 'border-primary/30 bg-primary/5'}`}>
            <div className="flex items-start gap-2.5">
              <button type="button" disabled={!personId} aria-label={`View ${name}'s profile`} className="shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { if (personId) openUserProfile(personId); }}><Avatar id={personId} name={name} src={person?.avatar_url} /></button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"><strong>{name}</strong><span className="inline-flex items-center gap-1 text-muted-foreground"><Icon size={13} />{labels[item.kind]}</span>{!item.read && <span className="rounded bg-primary/15 px-1.5 text-primary">Unread</span>}</div>
                <time className="mt-1 block text-xs text-muted-foreground" dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
                <p className="my-2 line-clamp-3 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{formatMessagePreview(item.message?.body ?? item.dm_request?.body ?? '') || (item.message?.attachments?.length ? 'Attachment' : '')}</p>
                {item.message && <Button variant="outline" size="sm" className="phone:min-h-11" disabled={!room} onClick={() => { if (room && item.message) { onClose(); onOpenMessage(room, item.message); } }}>{room ? `Open ${roomLabel(room)}` : 'Conversation unavailable'}</Button>}
                {(item.friend_request || item.dm_request) && <div className="flex gap-2"><Button size="sm" className="phone:min-h-11" disabled={Boolean(busy)} onClick={() => void answer(item, true)}><Check size={14} />Accept</Button><Button size="sm" variant="ghost" className="phone:min-h-11" disabled={Boolean(busy)} onClick={() => void answer(item, false)}><X size={14} />Decline</Button></div>}
              </div>
            </div>
          </li>;
        })}
      </ul>
      {state.cursor && <Button variant="outline" className="mt-3 w-full phone:min-h-11" disabled={state.loading} onClick={() => void feed.load(true)}>{state.loading ? 'Loading…' : 'More activity'}</Button>}
      {state.items.length === 300 && <p className="mt-3 text-center text-xs text-muted-foreground">Showing the latest 300 items. Use message search for older conversations.</p>}
    </div>
  </AppDialog>;
}
