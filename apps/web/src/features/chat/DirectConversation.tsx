import { ChevronLeft, Phone } from 'lucide-react';
import { type Message, type Room, type User } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { useActiveCall } from '@/features/call/CallSessionContext';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import { cn } from '@/lib/utils';
import MessageThread from './MessageThread';

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
  targetId,
  onError,
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
  onError: (message: string) => void;
  targetId?: string;
}) {
  const call = useActiveCall();
  const name = roomLabel(room);
  const inThisCall = call.joined && call.callRoom?.id === room.id;

  return (
    <section
      className={cn(
        'flex min-w-0 flex-1 flex-col overflow-hidden bg-background',
        docked && 'pb-24',
        variant === 'screen'
          ? 'content-canvas rounded-3xl border border-border/60 shadow-[0_20px_60px_rgb(0_0_0/0.16)]'
          : 'rounded-2xl border border-border/60',
      )}
      aria-label={`Conversation with ${name}`}
    >
      <header className="flex items-center gap-2.5 px-4 py-2.5">
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="hidden shrink-0 phone:inline-flex"
            aria-label="Back to call"
            onClick={onClose}
          >
            <ChevronLeft size={20} />
          </Button>
        )}
        <Avatar name={name} id={room.id} />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm font-semibold">
            {name}
          </strong>
          <span className="text-[0.65rem] text-muted-foreground">
            {inThisCall ? 'In a call with you' : 'Direct message'}
          </span>
        </div>
        {/* The one place the conversation reaches for the call: pressing this
            starts it, rather than opening a lobby to press again. */}
        {!inThisCall && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={!user || call.busy}
            onClick={() => {
              void call.join('replace');
              onCall();
            }}
          >
            <Phone size={15} /> Call
          </Button>
        )}
      </header>

      {user && (
        <MessageThread
          key={`${user.id}:${room.id}:${targetId ?? ''}`}
          roomId={room.id}
          user={user}
          label={name}
          targetId={targetId}
          onError={onError}
        />
      )}
    </section>
  );
}
