import { useSyncExternalStore } from 'react';
import { activitySnapshot, subscribeActivity, subscribeUnread, unreadSnapshot } from '@/features/chat/messageStore';
import {
  Hash,
  Headphones,
  HeadphoneOff,
  MessageSquare,
  MicOff,
  Plus,
  Users,
  Star,
} from 'lucide-react';
import type { CallParticipant, Room, User } from '@/api';
import RoomContextMenu from './RoomContextMenu';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { conversationPreferencesSnapshot, sortConversations, subscribeConversationPreferences } from './conversationPreferences';
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
  onCreate,
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
  const preferenceState = useSyncExternalStore(subscribeConversationPreferences, conversationPreferencesSnapshot);
  const preferences = preferenceState.userId === user?.id ? preferenceState.preferences : {};
  const sortedRooms = sortConversations(rooms, preferences, activity);
  return (
    <div className="conversation-navigation min-h-0 overflow-x-hidden overflow-y-auto">
      <SidebarGroup
        role="region"
        aria-label={kind === 'direct' ? 'Direct messages' : 'Rooms'}
      >
        <SidebarGroupLabel className="justify-between">
          {kind === 'direct' ? 'Conversations' : 'Rooms'}
          {kind === 'channel' && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg phone:size-10"
              aria-label="Create room"
              onClick={onCreate}
            >
              <Plus size={16} />
            </Button>
          )}
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
                      'h-10 pr-9',
                      selected === room.id && 'font-semibold',
                    )}
                    isActive={selected === room.id}
                    aria-current={selected === room.id ? 'page' : undefined}
                    onClick={() => onSelect(room)}
                    title={roomLabel(room)}
                    aria-label={`${roomLabel(room)}${known && callers.length ? ` ${callers.length} in call` : ''}`}
                  >
                    {room.kind === 'group' ? <Users size={18} /> : kind === 'direct' ? (
                      <MessageSquare size={18} />
                    ) : (
                      <Hash size={19} />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {roomLabel(room)}
                    </span>
                    {preferences[room.id]?.favorite && <Star size={12} className="shrink-0 fill-primary text-primary" aria-hidden="true" />}
                    {(unread[room.id]?.unread ?? 0) > 0 && (
                      <Badge
                        aria-label={`${unread[room.id].unread} unread messages${unread[room.id].mentions ? `, ${unread[room.id].mentions} mentions` : ''}`}
                        className="h-5 px-1.5"
                      >
                        {unread[room.id].mentions ? '@ ' : ''}
                        {unread[room.id].unread}
                      </Badge>
                    )}
                    {known && callers.length > 0 && (
                      <Badge
                        className="h-5 gap-1 px-1.5"
                        aria-label={`${callers.length} in call`}
                      >
                        <Headphones size={12} />
                        {callers.length}
                      </Badge>
                    )}
                  </SidebarMenuButton>
                </RoomContextMenu>
                {user && <div className="absolute top-1 right-1"><ConversationPreferenceActions room={room} userId={user.id} onError={onError} /></div>}
                </div>
                {known && callers.length > 0 && (
                  <ul
                    className="mt-1 mb-3 ml-5 list-none border-l pl-3"
                    aria-label={`${roomLabel(room)} call participants`}
                  >
                    {callers.map((person) => (
                      <li
                        className="flex min-w-0 items-center gap-2 py-1 pr-1 text-xs text-foreground/75 [&>svg]:shrink-0"
                        key={person.user_id}
                      >
                        <span
                          className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[0.65rem] text-muted-foreground"
                          aria-hidden="true"
                        >
                          {(person.name || '?').slice(0, 1).toUpperCase()}
                        </span>
                        <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" aria-label={`View ${person.name || 'participant'}'s profile`} onClick={() => openUserProfile(person.user_id)}>
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
                            className="mr-1 size-1.5 rounded-full bg-primary"
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
        <p className="mx-2 my-3 text-xs text-muted-foreground">
          Call activity unavailable
        </p>
      )}
    </div>
  );
}
