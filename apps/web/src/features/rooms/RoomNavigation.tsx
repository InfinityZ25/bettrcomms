import {
  Hash,
  Headphones,
  HeadphoneOff,
  MessageSquare,
  MicOff,
  Plus,
} from 'lucide-react';
import type { CallParticipant, Room, User } from '@/api';
import RoomContextMenu from './RoomContextMenu';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';

export const roomLabel = (room: Room) => room.display_name || room.name;

export default function RoomNavigation({
  rooms,
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
  return (
    <div className="conversation-navigation min-h-0 overflow-x-hidden overflow-y-auto">
      {(['channel', 'direct'] as const).map((kind) => {
        const entries = rooms.filter(
          (room) => (room.kind ?? 'channel') === kind,
        );
        if (kind === 'direct' && !entries.length) return null;
        return (
          <SidebarGroup
            key={kind}
            role="region"
            aria-label={kind === 'direct' ? 'Direct messages' : 'Rooms'}
          >
            <SidebarGroupLabel className="mt-3 justify-between">
              {kind === 'direct' ? 'DIRECT MESSAGES' : 'ROOMS'}
              {kind === 'channel' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-lg"
                  aria-label="Create room"
                  onClick={onCreate}
                >
                  <Plus size={16} />
                </Button>
              )}
            </SidebarGroupLabel>
            {!entries.length && (
              <p className="px-2 py-1 text-xs leading-6 text-muted-foreground">
                Create a room to bring your friends together.
              </p>
            )}
            <SidebarMenu>{entries.map((room) => {
              const callers = presence[room.id] ?? [];
              return (
                <SidebarMenuItem key={room.id}>
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
                        'h-10',
                        selected === room.id && 'font-semibold',
                      )}
                      isActive={selected === room.id}
                      aria-current={selected === room.id ? 'page' : undefined}
                      onClick={() => onSelect(room)}
                      title={roomLabel(room)}
                    >
                      {kind === 'direct' ? (
                        <MessageSquare size={18} />
                      ) : (
                        <Hash size={19} />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {roomLabel(room)}
                      </span>
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
                          <span className="min-w-0 flex-1 truncate">
                            {person.name || 'Participant'}
                            {person.device_count > 1
                              ? ` · ${person.device_count} devices`
                              : ''}
                          </span>
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
            })}</SidebarMenu>
          </SidebarGroup>
        );
      })}
      {!known && rooms.length > 0 && (
        <p className="mx-2 my-3 text-xs text-muted-foreground">
          Call activity unavailable
        </p>
      )}
    </div>
  );
}
