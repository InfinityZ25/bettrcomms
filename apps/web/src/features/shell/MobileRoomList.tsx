import { useState, useSyncExternalStore } from 'react';
import {
  ChevronRight,
  Headphones,
  Plus,
  Search,
  Star,
  Users,
} from 'lucide-react';
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
import { isConversationRoom, type Section } from './sections';
import {
  conversationPreferencesSnapshot,
  sortConversations,
  subscribeConversationPreferences,
} from '@/features/rooms/conversationPreferences';
import ConversationArchiveFilter from '@/features/rooms/ConversationArchiveFilter';
import ConversationPreferenceActions from '@/features/rooms/ConversationPreferenceActions';
import CommunityNavigation from '@/features/rooms/CommunityNavigation';

export default function MobileRoomList({
  section,
  rooms,
  user,
  presence,
  known,
  onSelect,
  onCreate,
  onFriends,
  onCreateGroup,
  onJoinInvitation,
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
  onCreateGroup: () => void;
  onJoinInvitation: () => void;
  onSettings: (room: Room) => void;
  onInvite: (room: Room) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const preferenceState = useSyncExternalStore(
    subscribeConversationPreferences,
    conversationPreferencesSnapshot,
  );
  const preferences =
    preferenceState.userId === user?.id ? preferenceState.preferences : {};
  const unread = useSyncExternalStore(subscribeUnread, unreadSnapshot);
  const activity = useSyncExternalStore(subscribeActivity, activitySnapshot);
  const messages = section === 'messages';
  const all = rooms.filter((room) =>
    messages ? isConversationRoom(room.kind) : !isConversationRoom(room.kind),
  );
  const filtered = sortConversations(
    all
      .filter(
        (room) =>
          !messages || Boolean(preferences[room.id]?.archived) === archived,
      )
      .filter((room) =>
        `${room.community_name ?? ''} ${roomLabel(room)}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      ),
    preferences,
    activity,
  );
  return (
    <main
      className="mobile-room-list flex min-h-0 flex-1 flex-col bg-background"
      aria-label={messages ? 'Messages' : 'Rooms'}
    >
      <header className="flex shrink-0 items-center gap-3 px-5 pt-5 pb-3">
        <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight">
          {messages ? 'Messages' : 'Rooms'}
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
      {user && (
        <div className="mx-4 mb-3">
          <Button
            variant="secondary"
            className="h-11 w-full"
            onClick={messages ? onCreateGroup : onJoinInvitation}
          >
            {messages ? 'New group message' : 'Join with invitation'}
          </Button>
        </div>
      )}
      {user && messages && (
        <div className="mx-4 mb-3">
          <ConversationArchiveFilter
            archived={archived}
            count={all.filter((room) => preferences[room.id]?.archived).length}
            onChange={setArchived}
          />
        </div>
      )}
      <label className="relative mx-4 mb-3 block shrink-0">
        <Search
          className="pointer-events-none absolute top-3 left-3 text-muted-foreground"
          size={20}
        />
        <input
          type="search"
          enterKeyHint="search"
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          aria-label={messages ? 'Filter conversations' : 'Filter rooms'}
          placeholder={messages ? 'Find a conversation' : 'Find a room'}
          className="h-11 pl-10!"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
        {!messages && !known && filtered.length > 0 && (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            Call activity unavailable
          </p>
        )}
        {filtered.length && !messages ? (
          <CommunityNavigation
            mobile
            rooms={filtered}
            user={user}
            presence={presence}
            known={known}
            onSelect={onSelect}
            onSettings={onSettings}
            onInvite={onInvite}
            onChanged={onChanged}
            onError={onError}
          />
        ) : filtered.length ? (
          <ul aria-label={messages ? 'Direct messages' : 'Rooms'}>
            {filtered.map((room) => {
              const callers = presence[room.id] ?? [];
              const count = unread[room.id]?.unread ?? 0;
              return (
                <li key={room.id} className="relative">
                  <RoomContextMenu
                    room={room}
                    user={user}
                    onSettings={onSettings}
                    onInvite={onInvite}
                    onChanged={onChanged}
                    onError={onError}
                  >
                    <button
                      className="flex min-h-20 w-full items-center gap-3 rounded-2xl px-3 py-3 pr-14 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
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
                          {preferences[room.id]?.favorite && (
                            <Star
                              size={13}
                              className="mr-1 inline fill-primary text-primary"
                              aria-hidden="true"
                            />
                          )}
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
                            room.kind === 'group' ? (
                              'Group message'
                            ) : (
                              'Direct message'
                            )
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
                  {user && (
                    <div className="absolute top-4 right-1">
                      <ConversationPreferenceActions
                        room={room}
                        userId={user.id}
                        onError={onError}
                      />
                    </div>
                  )}
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
                : archived && messages
                  ? 'No archived conversations'
                  : messages
                    ? 'Start a conversation'
                    : 'Make room for your friends'}
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {query
                ? 'Try another name.'
                : archived && messages
                  ? 'Archived conversations keep their history and membership. Alerts follow your notification settings.'
                  : messages
                    ? 'Find a friend and send them a message.'
                    : 'Create a room to talk, watch and share together.'}
            </p>
            {!query && !archived && (
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
