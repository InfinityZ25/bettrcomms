import {
  CheckCheck,
  ChevronLeft,
  MoreHorizontal,
  Phone,
  Search,
  Users,
} from 'lucide-react';
import { type Message, type Room, type User } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { useActiveCall } from '@/features/call/CallSessionContext';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import { cn } from '@/lib/utils';
import MessageThread from './MessageThread';
import { openMessageSearch } from './searchEvents';
import { conversationSnapshot, markRead } from './messageStore';
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
  const name = roomLabel(room);
  const inThisCall = call.joined && call.callRoom?.id === room.id;

  return (
    <section
      className={cn(
        'flex min-w-0 flex-1 flex-col overflow-hidden bg-background',
        docked && 'pb-24 phone:pb-0',
        variant === 'screen'
          ? 'content-canvas rounded-3xl border border-border/60 shadow-[0_20px_60px_rgb(0_0_0/0.16)]'
          : 'rounded-2xl border border-border/60',
      )}
      aria-label={`Conversation with ${name}`}
    >
      <header className="conversation-header flex shrink-0 items-center gap-2.5 border-b px-4 py-2.5 phone:gap-2 phone:px-2 phone:py-2">
        {(onClose || onBack) && (
          <Button
            variant="ghost"
            size="icon"
            className="hidden shrink-0 phone:inline-flex phone:size-11"
            aria-label={onClose ? 'Back to call' : 'Back to messages'}
            onClick={onClose ?? onBack}
          >
            <ChevronLeft size={20} />
          </Button>
        )}
        <Avatar name={name} id={room.id} />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm font-semibold phone:text-base">
            {name}
          </strong>
          <span className="text-[0.65rem] text-muted-foreground phone:text-xs">
            {inThisCall ? 'In a call with you' : room.kind === 'group' ? 'Group message' : 'Direct message'}
          </span>
        </div>
        {/* The one place the conversation reaches for the call: pressing this
            starts it, rather than opening a lobby to press again. */}
        {!inThisCall && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0 phone:h-11 phone:rounded-full"
            disabled={!user || call.busy}
            onClick={() => {
              void call.join('replace');
              onCall();
            }}
          >
            <Phone size={15} /> Call
          </Button>
        )}
        {room.kind === 'group' && onGroupInfo && <Button variant="ghost" size="icon" aria-label="Group info" onClick={onGroupInfo}><Users size={18} /></Button>}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="hidden shrink-0 phone:inline-flex phone:size-11"
                aria-label="Conversation options"
              />
            }
          >
            <MoreHorizontal size={21} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => openMessageSearch(room.id)}
            >
              <Search /> Search this conversation
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

      {user && (
        <MessageThread
          key={`${user.id}:${room.id}:${targetId ?? ''}`}
          roomId={room.id}
          user={user}
          label={name}
          compactHeader
          canModerate={room.kind === 'group' && room.owner_id === user.id}
          targetId={targetId}
          onError={onError}
        />
      )}
    </section>
  );
}
