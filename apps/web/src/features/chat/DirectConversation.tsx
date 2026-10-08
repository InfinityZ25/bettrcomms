import { useState, useSyncExternalStore } from 'react';
import {
  CheckCheck,
  ChevronLeft,
  MoreHorizontal,
  Phone,
  Pin,
  Search,
  MessagesSquare,
  Users,
  Hash,
  Headphones,
  Megaphone,
  Settings2,
  FolderOpen,
} from 'lucide-react';
import { type Message, type Room, type User } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { useActiveCall } from '@/features/call/CallSessionContext';
import { SecondDevice } from '@/features/call/CallLobby';
import {
  callPresenceSnapshot,
  subscribeCallPresence,
} from '@/features/call/useCallPresence';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import { cn } from '@/lib/utils';
import MessageThread from './MessageThread';
import { openMessageSearch } from './searchEvents';
import { conversationSnapshot, markRead } from './messageStore';
import { openConversationPanel } from './conversationPanels';
import { ChannelActivities } from '@/features/activities/ChannelActivities';
import ChannelFileLibrary from './ChannelFileLibrary';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * A conversation with one person.
 *
 * Opening a direct message used to land you in that room's call lobby, which
 * offered to start a call and no way to say anything — the panel that held the
 * messages was a drawer bolted to the side of a room, and it left when the
 * room chrome did. The conversation is the content here, and during a call it
 * moves to a column beside it rather than being replaced by it.
 */
export default function DirectConversation({
  room,
  user,
  variant = 'screen',
  docked = false,
  onCall,
  onClose,
  onBack,
  targetId,
  onError,
  onGroupInfo,
}: {
  room: Room;
  user: User | null;
  /** Messages the realtime stream has delivered since this screen loaded. */
  live: { sequence: number; value: Message }[];
  /** `panel` sits inside another surface, so it draws no frame of its own. */
  variant?: 'screen' | 'panel';
  /** A call is running and its dock is sitting in the bottom-left corner. */
  docked?: boolean;
  /** Open the call for this conversation. */
  onCall: () => void;
  onClose?: () => void;
  onBack?: () => void;
  onError: (message: string) => void;
  onGroupInfo?: () => void;
  targetId?: string;
}) {
  const call = useActiveCall();
  const [filesOpen, setFilesOpen] = useState(false);
  const name = roomLabel(room);
  const inThisCall = call.joined && call.callRoom?.id === room.id;
  const channel = (room.kind ?? 'channel') === 'channel';
  const announcement = channel && room.channel_type === 'announcement';
  const canJoinVoice =
    !announcement &&
    room.can_join_voice !== false &&
    room.permissions?.join_voice !== false;
  const presence = useSyncExternalStore(
    subscribeCallPresence,
    callPresenceSnapshot,
  );
  const alreadyIn =
    !inThisCall &&
    presence.rooms[room.id]?.find((person) => person.user_id === user?.id);

  return (
    <section
      className={cn(
        '@container/conversation flex min-w-0 flex-1 flex-col overflow-hidden bg-background',
        docked && 'pb-24 phone:pb-0',
        variant === 'screen'
          ? 'content-canvas rounded-3xl border border-border/60 shadow-[0_20px_60px_rgb(0_0_0/0.16)]'
          : 'rounded-2xl border border-border/60',
      )}
      aria-label={
        channel
          ? `${room.community_name ?? 'Room'} · ${name}`
          : `Conversation with ${name}`
      }
    >
      <header className="conversation-header flex shrink-0 items-center gap-2.5 border-b px-4 py-2.5 phone:gap-2 phone:px-2 phone:py-2">
        {(onClose || onBack) && (
          <Button
            variant="ghost"
            size="icon"
            className="hidden shrink-0 phone:inline-flex phone:size-11 @max-[480px]/conversation:inline-flex @max-[480px]/conversation:size-11"
            aria-label={
              onClose
                ? 'Back to call'
                : channel
                  ? 'Back to rooms'
                  : 'Back to messages'
            }
            onClick={onClose ?? onBack}
          >
            <ChevronLeft size={20} />
          </Button>
        )}
        {channel ? (
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted phone:hidden @max-[480px]/conversation:hidden">
            {announcement ? <Megaphone size={18} /> : <Hash size={20} />}
          </span>
        ) : (
          <Avatar name={name} id={room.id} />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="block truncate text-sm font-semibold phone:text-base">
            {channel && (
              <span className="mr-1 font-normal text-muted-foreground phone:hidden @max-[480px]/conversation:hidden">
                {room.community_name} /
              </span>
            )}
            {name}
          </h2>
          <span
            className="block truncate text-[0.65rem] text-muted-foreground phone:text-xs"
            title={room.topic}
          >
            {channel
              ? room.topic ||
                (announcement
                  ? 'Announcements · owner and admins publish'
                  : inThisCall
                    ? 'Connected to voice'
                    : 'Text and voice together')
              : inThisCall
                ? 'In a call with you'
                : room.kind === 'group'
                  ? 'Group message'
                  : 'Direct message'}
          </span>
        </div>
        {/* The one place the conversation reaches for the call: pressing this
            starts it, rather than opening a lobby to press again. */}
        {canJoinVoice && !alreadyIn && (!inThisCall || channel) && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0 phone:size-11 phone:rounded-full phone:px-0 @max-[480px]/conversation:size-11 @max-[480px]/conversation:px-0"
            aria-label={
              channel ? (inThisCall ? 'Open voice' : 'Join voice') : 'Call'
            }
            disabled={!user || call.busy}
            onClick={() => {
              if (!inThisCall)
                void call.join('replace', room).then((success) => {
                  if (success) onCall();
                });
              else onCall();
            }}
          >
            {channel ? <Headphones size={15} /> : <Phone size={15} />}{' '}
            <span className="phone:hidden @max-[480px]/conversation:hidden">
              {channel ? (inThisCall ? 'Open voice' : 'Join voice') : 'Call'}
            </span>
          </Button>
        )}
        {room.kind === 'group' && onGroupInfo && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Group info"
            onClick={onGroupInfo}
          >
            <Users size={18} />
          </Button>
        )}
        {channel && onGroupInfo && (
          <Button
            variant="ghost"
            size="icon"
            className="phone:hidden @max-[480px]/conversation:hidden"
            aria-label="Room settings"
            onClick={onGroupInfo}
          >
            <Settings2 size={18} />
          </Button>
        )}
        {channel && user && (
          <ChannelActivities
            key={`${user.id}:${room.id}`}
            room={room}
            user={user}
          />
        )}
        {user && (
          <Button
            variant="ghost"
            size="icon"
            className="phone:hidden @max-[480px]/conversation:hidden"
            aria-label="Channel file library"
            onClick={() => setFilesOpen(true)}
          >
            <FolderOpen size={17} />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="hidden shrink-0 phone:inline-flex phone:size-11 @max-[480px]/conversation:inline-flex @max-[480px]/conversation:size-11"
                aria-label="Conversation options"
              />
            }
          >
            <MoreHorizontal size={21} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {user && (
              <DropdownMenuItem
                className="min-h-11"
                onClick={() => setFilesOpen(true)}
              >
                <FolderOpen /> Channel file library
              </DropdownMenuItem>
            )}
            {channel && onGroupInfo && (
              <DropdownMenuItem className="min-h-11" onClick={onGroupInfo}>
                <Settings2 /> Room settings
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => openMessageSearch(room.id)}
            >
              <Search /> Search this conversation
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => openConversationPanel(room.id, 'pins')}
            >
              <Pin /> Pinned messages
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => openConversationPanel(room.id, 'threads')}
            >
              <MessagesSquare /> Conversation threads
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => {
                const last = conversationSnapshot(room.id).messages.at(-1);
                if (last)
                  void markRead(room.id, last).catch((error) =>
                    onError(
                      error instanceof Error
                        ? error.message
                        : 'Could not mark messages as read',
                    ),
                  );
              }}
            >
              <CheckCheck /> Mark as read
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {canJoinVoice && alreadyIn && user && (
        <div className="shrink-0 px-4 py-3">
          <SecondDevice
            devices={alreadyIn.device_count}
            busy={call.busy}
            onJoin={(mode) => {
              void call.join(mode, room).then((success) => {
                if (success) onCall();
              });
            }}
          />
        </div>
      )}

      {user && (
        <MessageThread
          key={`${user.id}:${room.id}:${targetId ?? ''}`}
          roomId={room.id}
          user={user}
          label={name}
          compactHeader
          canPin={
            room.permissions?.pin_messages ??
            (room.kind !== 'channel' || room.owner_id === user.id)
          }
          canModerate={
            room.permissions?.moderate ??
            (room.kind === 'group' && room.owner_id === user.id)
          }
          canPost={room.can_post !== false && room.permissions?.post !== false}
          postingReason={
            announcement
              ? 'Only the room owner and admins can publish announcements.'
              : undefined
          }
          targetId={targetId}
          onError={onError}
        />
      )}
      {filesOpen && user && (
        <ChannelFileLibrary
          key={`${user.id}:${room.id}`}
          roomId={room.id}
          userId={user.id}
          canModerate={room.permissions?.moderate}
          onError={onError}
          onClose={() => setFilesOpen(false)}
        />
      )}
    </section>
  );
}
