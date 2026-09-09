import { Hash, Headphones, MessageSquare, Settings2, ShieldCheck, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import type { Room } from '@/api';
import { cn } from '@/lib/utils';

/** Names the room on screen and carries the room-level actions. */
export default function RoomHeader({
  room,
  callRoom,
  chatOpen,
  compact,
  hidden,
  onToggleChat,
  onRoomSettings,
  onFriends,
  onReturnToCall,
}: {
  room: Room | null;
  callRoom: Room | null;
  chatOpen: boolean;
  compact: boolean;
  hidden: boolean;
  onToggleChat: () => void;
  onRoomSettings: () => void;
  onFriends: () => void;
  onReturnToCall: (room: Room) => void;
}) {
  return (
    <header
      className={cn(
        'flex h-[70px] shrink-0 items-center justify-between gap-2.5 border-b px-3 min-[481px]:px-5 min-[1001px]:h-20 min-[1001px]:gap-5 min-[1001px]:px-7',
        compact && 'h-14 min-[1001px]:h-14',
        hidden && 'hidden',
      )}
    >
      <div className="flex min-w-0 items-center gap-2 min-[481px]:gap-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
        {room?.kind === 'direct' ? <MessageSquare size={22} /> : <Hash size={22} />}
        <strong className="max-w-[125px] truncate text-sm min-[481px]:max-w-[170px] min-[821px]:max-w-xs">
          {room ? roomLabel(room) : 'The living room'}
        </strong>
        <span className="hidden h-5 w-px bg-border min-[821px]:block" />
        <span className="hidden text-xs text-muted-foreground min-[1251px]:inline">
          {room?.kind === 'direct' ? 'Direct conversation' : 'A place to hang out'}
        </span>
      </div>
      <div className="flex items-center gap-1 min-[481px]:gap-3">
        {callRoom && room?.id !== callRoom.id && (
          <Button
            variant="secondary"
            className="max-w-48 truncate"
            onClick={() => onReturnToCall(callRoom)}
          >
            <Headphones size={15} /> Return to {roomLabel(callRoom)}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Room settings"
          disabled={!room}
          onClick={onRoomSettings}
        >
          <Settings2 size={18} />
        </Button>
        <span className="hidden items-center gap-2 text-xs text-muted-foreground min-[1251px]:flex">
          <ShieldCheck size={15} /> Private room
        </span>
        <Button variant="ghost" size="icon" onClick={onFriends} aria-label="Invite friends">
          <Users size={19} />
        </Button>
        <Button
          variant={chatOpen ? 'secondary' : 'ghost'}
          size="icon"
          onClick={onToggleChat}
          aria-label="Toggle chat"
        >
          <MessageSquare size={18} />
        </Button>
      </div>
    </header>
  );
}
