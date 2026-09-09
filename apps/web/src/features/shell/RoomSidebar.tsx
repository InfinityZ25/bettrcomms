import { ChevronDown, Headphones, Settings2, Users } from 'lucide-react';
import { Avatar } from '@/components/avatar';
import RoomNavigation from '@/features/rooms/RoomNavigation';
import type { CallParticipant, Room, User } from '@/api';
import { cn } from '@/lib/utils';
import type { Screen } from './useScreenRoute';

/** The wide-screen room list, hidden once a call takes over the layout. */
export default function RoomSidebar({
  user,
  rooms,
  room,
  presence,
  presenceKnown,
  screen,
  hiddenInCall,
  hidden,
  onSelectRoom,
  onCreateRoom,
  onFriends,
  onSettings,
}: {
  user: User | null;
  rooms: Room[];
  room: Room | null;
  presence: Record<string, CallParticipant[]>;
  presenceKnown: boolean;
  screen: Screen;
  hiddenInCall: boolean;
  hidden: boolean;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: () => void;
  onFriends: () => void;
  onSettings: () => void;
}) {
  return (
    <aside
      className={cn(
        'hidden w-[170px] shrink-0 flex-col border-r bg-sidebar px-4 min-[821px]:flex min-[1251px]:w-[190px] min-[1400px]:w-[232px]',
        hiddenInCall && 'min-[821px]:hidden',
        hidden && 'hidden',
      )}
      inert={screen === 'share'}
    >
      <div className="flex h-[70px] shrink-0 items-center justify-between px-2 font-heading text-base font-bold min-[1001px]:h-20">
        Your space <ChevronDown size={16} />
      </div>
      <button
        className="flex items-center gap-3 rounded-lg px-2.5 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        onClick={onFriends}
      >
        <Users size={18} /> Friends <span className="ml-auto opacity-60">↗</span>
      </button>
      <RoomNavigation
        rooms={rooms}
        selected={room?.id}
        presence={presence}
        known={presenceKnown}
        onSelect={onSelectRoom}
        onCreate={onCreateRoom}
      />
      <div className="mx-2 mt-auto mb-6 pt-6">
        <span className="mb-4 grid size-9 place-items-center rounded-xl bg-accent text-muted-foreground">
          <Headphones size={20} />
        </span>
        <strong className="font-heading text-sm leading-6 font-semibold text-foreground/75">
          Good company.
          <br />
          Room to be yourself.
        </strong>
        <p className="mt-2 max-w-40 text-xs leading-5 text-muted-foreground">
          Your calls, the way you like them.
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2.5 border-t py-5">
        <Avatar name={user?.name ?? 'You'} />
        <div className="min-w-0 flex-1 overflow-hidden">
          <strong className="block truncate text-xs">
            {user?.name ?? 'Welcome in'}
          </strong>
          <span className="mt-1 flex items-center gap-1 text-[0.65rem] text-muted-foreground">
            <i className="size-1.5 rounded-full bg-primary" />
            {user ? 'Available' : 'Make yourself at home'}
          </span>
        </div>
        <button
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="Settings"
          onClick={onSettings}
        >
          <Settings2 size={18} />
        </button>
      </div>
    </aside>
  );
}
