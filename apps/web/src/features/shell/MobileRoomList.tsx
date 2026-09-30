import { useState, useSyncExternalStore } from 'react';
import { ChevronRight, Headphones, Plus, Search, Users } from 'lucide-react';
import type { CallParticipant, Room, User } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Mascot } from '@/components/mascot';
import {
  activitySnapshot,
  subscribeActivity,
  subscribeUnread,
  unreadSnapshot,
} from '@/features/chat/messageStore';
import { openMessageSearch } from '@/features/chat/searchEvents';
import RoomContextMenu from '@/features/rooms/RoomContextMenu';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import type { Section } from './sections';

export default function MobileRoomList({
  section,
  rooms,
  user,
  presence,
  known,
  onSelect,
  onCreate,
  onFriends,
  onSettings,
  onInvite,
  onChanged,
  onError,
}: {
  section: Section;
  rooms: Room[];
  user: User | null;
  presence: Record<string, CallParticipant[]>;
  known: boolean;
  onSelect: (room: Room) => void;
  onCreate: () => void;
  onFriends: () => void;
  onSettings: (room: Room) => void;
  onInvite: (room: Room) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const unread = useSyncExternalStore(subscribeUnread, unreadSnapshot);
  const activity = useSyncExternalStore(subscribeActivity, activitySnapshot);
  const messages = section === 'messages';
  const all = rooms.filter(
    (room) => (room.kind ?? 'channel') === (messages ? 'direct' : 'channel'),
  );
  const filtered = all
    .filter((room) =>
      roomLabel(room)
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        (Date.parse(activity[b.id] ?? b.activity_at ?? b.created_at) || 0) -
        (Date.parse(activity[a.id] ?? a.activity_at ?? a.created_at) || 0),
    );
  return (
    <main
      className="mobile-room-list flex min-h-0 flex-1 flex-col bg-background"
      aria-label={messages ? 'Messages' : 'Calls'}
    >
      <header className="flex shrink-0 items-center gap-3 px-5 pt-5 pb-3">
        <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight">
          {messages ? 'Messages' : 'Calls'}
        </h1>
        <Button
          variant="secondary"
          size="icon"
          className="size-11 rounded-full"
          aria-label={messages ? 'Find friends' : 'Create room'}
          onClick={messages ? onFriends : onCreate}
        >
          <Plus size={20} />
        </Button>
        {user && (
          <Button
            variant="ghost"
            size="icon"
            className="size-11 rounded-full"
            aria-label="Search all messages"
            onClick={() => openMessageSearch()}
          >
            <Search size={20} />
          </Button>
        )}
      </header>
      <label className="relative mx-4 mb-3 block shrink-0">
        <Search
          className="pointer-events-none absolute top-3 left-3 text-muted-foreground"
          size={20}
        />
        <input
          aria-label={messages ? 'Filter conversations' : 'Filter rooms'}
          placeholder={messages ? 'Find a conversation' : 'Find a room'}
          className="h-11 pl-10!"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
        {filtered.length ? (
          <ul aria-label={messages ? 'Direct messages' : 'Rooms'}>
            {filtered.map((room) => {
              const callers = presence[room.id] ?? [];
              const count = unread[room.id]?.unread ?? 0;
              return (
                <li key={room.id}>
                  <RoomContextMenu
                    room={room}
                    user={user}
                    onSettings={onSettings}
                    onInvite={onInvite}
                    onChanged={onChanged}
                    onError={onError}
                  >
                    <button
                      className="flex min-h-20 w-full items-center gap-3 rounded-2xl px-3 py-3 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={roomLabel(room)}
                      onClick={() => onSelect(room)}
                    >
                      <Avatar
                        name={roomLabel(room)}
                        id={room.id}
                        className="size-11 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-base font-semibold">
                          {roomLabel(room)}
                        </strong>
                        <span className="mt-1 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                          {known && callers.length ? (
                            <>
                              <Headphones size={14} />
                              {callers.length}{' '}
                              {callers.length === 1 ? 'person' : 'people'} in
                              the call
                            </>
                          ) : messages ? (
                            'Direct message'
                          ) : (
                            'Open room'
                          )}
                        </span>
                      </span>
                      {count > 0 && (
                        <span
                          className="grid min-w-6 place-items-center rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-foreground"
                          aria-label={`${count} unread messages`}
                        >
                          {count > 99 ? '99+' : count}
                        </span>
                      )}
                      <ChevronRight
                        size={18}
                        className="shrink-0 text-muted-foreground"
                      />
                    </button>
                  </RoomContextMenu>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 px-5 text-center">
            <Mascot className="w-20" />
            <h2 className="text-lg font-semibold">
              {query
                ? 'No matches'
                : messages
                  ? 'Start a conversation'
                  : 'Make room for your friends'}
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {query
                ? 'Try another name.'
                : messages
                  ? 'Find a friend and send them a message.'
                  : 'Create a room to talk, watch and share together.'}
            </p>
            {!query && (
              <Button
                className="mt-2 h-11"
                onClick={messages ? onFriends : onCreate}
              >
                {messages ? <Users size={18} /> : <Plus size={18} />}
                {messages ? 'Find friends' : 'New room'}
              </Button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
