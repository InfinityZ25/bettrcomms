import { useSyncExternalStore } from 'react';
import {
  activitySnapshot,
  subscribeActivity,
  subscribeUnread,
  unreadSnapshot,
} from '@/features/chat/messageStore';
import {
  Headphones,
  HeadphoneOff,
  MicOff,
  Star,
} from 'lucide-react';
import type { CallParticipant, Room, User } from '@/api';
import ConversationAvatar from '@/features/chat/ConversationAvatar';
import RoomContextMenu from './RoomContextMenu';
import CommunityNavigation from './CommunityNavigation';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  conversationPreferencesSnapshot,
  sortConversations,
  subscribeConversationPreferences,
} from './conversationPreferences';
import ConversationPreferenceActions from './ConversationPreferenceActions';
import { openUserProfile } from '@/features/settings/ProfileDialog';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

export const roomLabel = (room: Room) => room.display_name || room.name;

/**
 * The rooms of one kind, as the sidebar's list.
 *
 * This grouped its own rooms by kind, which it no longer has any business
 * doing: the rail picks a section and the sidebar hands over the rooms of that
 * kind. Doing both meant a conversation list that opened with an empty ROOMS
 * heading telling you to create a room.
 */
export default function RoomNavigation({
  rooms,
  kind,
  user,
  selected,
  presence,
  known,
  onSelect,
  onRoomSettings,
  onInviteToRoom,
  onRoomsChanged,
  onError,
}: {
  rooms: Room[];
  kind: 'channel' | 'direct';
  user: User | null;
  selected?: string;
  presence: Record<string, CallParticipant[]>;
  known: boolean;
  onSelect: (room: Room) => void;
  onCreate: () => void;
  onRoomSettings: (room: Room) => void;
  onInviteToRoom: (room: Room) => void;
  onRoomsChanged: () => void;
  onError: (message: string) => void;
}) {
  const unread = useSyncExternalStore(subscribeUnread, unreadSnapshot);
  const activity = useSyncExternalStore(subscribeActivity, activitySnapshot);
  const preferenceState = useSyncExternalStore(
    subscribeConversationPreferences,
    conversationPreferencesSnapshot,
  );
  const preferences =
    preferenceState.userId === user?.id ? preferenceState.preferences : {};
  const sortedRooms = sortConversations(rooms, preferences, activity);
  if (kind === 'channel')
    return (
      <div className="min-h-0 overflow-y-auto">
        <CommunityNavigation
          rooms={rooms}
          user={user}
          selected={selected}
          presence={presence}
          known={known}
          onSelect={onSelect}
          onSettings={onRoomSettings}
          onInvite={onInviteToRoom}
          onChanged={onRoomsChanged}
          onError={onError}
        />
        {!known && rooms.length > 0 && (
          <p role="status" className="mx-3 my-3 text-xs text-muted-foreground">
            Call activity unavailable
          </p>
        )}
      </div>
    );
  return (
    <div className="conversation-navigation min-h-0 overflow-x-hidden overflow-y-auto">
      <SidebarGroup
        role="region"
        aria-label={kind === 'direct' ? 'Direct messages' : 'Rooms'}
      >
        <SidebarGroupLabel className="justify-between px-2 text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          {kind === 'direct' ? 'Conversations' : 'Rooms'}
        </SidebarGroupLabel>
        <SidebarMenu>
          {sortedRooms.map((room) => {
            const callers = presence[room.id] ?? [];
            return (
              <SidebarMenuItem key={room.id}>
                <div className="relative">
                  <RoomContextMenu
                    room={room}
                    user={user}
                    onSettings={onRoomSettings}
                    onInvite={onInviteToRoom}
                    onChanged={onRoomsChanged}
                    onError={onError}
                  >
                    <SidebarMenuButton
                      className={cn(
                        'h-11 gap-2.5 rounded-xl px-2 pr-9 text-muted-foreground hover:text-foreground',
                        selected === room.id && 'font-semibold text-foreground',
                        (unread[room.id]?.unread ?? 0) > 0 &&
                          'font-semibold text-foreground',
                        preferences[room.id]?.archived &&
                          selected !== room.id &&
                          '[&>span:first-child]:grayscale',
                      )}
                      isActive={selected === room.id}
                      aria-current={selected === room.id ? 'page' : undefined}
                      onClick={() => onSelect(room)}
                      title={roomLabel(room)}
                      aria-label={`${roomLabel(room)}${known && callers.length ? ` ${callers.length} in call` : ''}`}
                    >
                      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center">
                        <ConversationAvatar room={room} className="size-8" />
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {roomLabel(room)}
                      </span>
                      {preferences[room.id]?.favorite && (
                        <Star
                          size={12}
                          className="shrink-0 fill-primary text-primary"
                          aria-hidden="true"
                        />
                      )}
                      {(unread[room.id]?.unread ?? 0) > 0 && (
                        <Badge
                          aria-label={`${unread[room.id].unread} unread messages${unread[room.id].mentions ? `, ${unread[room.id].mentions} mentions` : ''}`}
                          className={cn(
                            'h-[18px] min-w-[18px] px-1.5 text-[0.6875rem] font-bold tabular-nums animate-bc-pop',
                            unread[room.id].mentions > 0 && 'bg-dnd text-white',
                          )}
                        >
                          {unread[room.id].mentions ? '@ ' : ''}
                          {unread[room.id].unread}
                        </Badge>
                      )}
                      {known && callers.length > 0 && (
                        <Badge
                          className="h-[18px] gap-1 bg-online/12 px-1.5 text-[0.6875rem] font-semibold text-foreground tabular-nums dark:text-online"
                          aria-label={`${callers.length} in call`}
                        >
                          <span
                            aria-hidden="true"
                            className="size-1.5 rounded-full bg-online animate-bc-pulse"
                          />
                          <Headphones size={12} />
                          {callers.length}
                        </Badge>
                      )}
                    </SidebarMenuButton>
                  </RoomContextMenu>
                  {user && (
                    <div className="absolute top-1.5 right-1">
                      <ConversationPreferenceActions
                        room={room}
                        userId={user.id}
                        onError={onError}
                      />
                    </div>
                  )}
                </div>
                {known && callers.length > 0 && (
                  <ul
                    className="mt-1 mb-2 ml-[1.375rem] list-none space-y-px border-l-2 border-online/25 pl-2.5"
                    aria-label={`${roomLabel(room)} call participants`}
                  >
                    {callers.map((person) => (
                      <li
                        className="flex min-w-0 items-center gap-2 py-1 pr-1 text-xs text-muted-foreground [&>svg]:shrink-0"
                        key={person.user_id}
                      >
                        <span
                          className={cn(
                            'grid size-5 shrink-0 place-items-center rounded-full bg-sidebar-accent text-[0.6875rem] leading-none font-bold text-foreground',
                            !person.muted &&
                              !person.deafened &&
                              'ring-2 ring-online/70',
                          )}
                          aria-hidden="true"
                        >
                          {(person.name || '?').slice(0, 1).toUpperCase()}
                        </span>
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-foreground hover:underline"
                          aria-label={`View ${person.name || 'participant'}'s profile`}
                          onClick={() => openUserProfile(person.user_id)}
                        >
                          {person.name || 'Participant'}
                          {person.device_count > 1
                            ? ` · ${person.device_count} devices`
                            : ''}
                        </button>
                        {person.deafened ? (
                          <HeadphoneOff size={14} aria-label="Deafened" />
                        ) : person.muted ? (
                          <MicOff size={14} aria-label="Muted" />
                        ) : (
                          <span
                            className="mr-1 size-1.5 rounded-full bg-online animate-bc-pulse"
                            aria-label="In call"
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroup>
      {!known && rooms.length > 0 && (
        <p className="mx-4 my-3 text-xs text-muted-foreground">
          Call activity unavailable
        </p>
      )}
    </div>
  );
}
