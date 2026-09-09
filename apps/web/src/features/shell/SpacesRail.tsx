import { AudioLines, Clapperboard, Plus, Settings2, Users } from 'lucide-react';
import { Avatar, initials } from '@/components/avatar';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import type { Room, User } from '@/api';
import { cn } from '@/lib/utils';
import type { Screen } from './useScreenRoute';

const railButton =
  'grid size-9 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground min-[481px]:size-11 min-[481px]:rounded-2xl';

/** The always-visible icon rail: spaces, friends, recordings and settings. */
export default function SpacesRail({
  user,
  rooms,
  room,
  screen,
  collapsed,
  hidden,
  onSelectRoom,
  onCreateRoom,
  onFriends,
  onRecordings,
  onSettings,
}: {
  user: User | null;
  rooms: Room[];
  room: Room | null;
  screen: Screen;
  collapsed: boolean;
  hidden: boolean;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: () => void;
  onFriends: () => void;
  onRecordings: () => void;
  onSettings: () => void;
}) {
  return (
    <nav
      className={cn(
        'flex w-[52px] shrink-0 flex-col items-center gap-3 bg-sidebar px-1.5 py-5 max-[480px]:gap-2 min-[481px]:w-[62px] min-[481px]:px-2 min-[1001px]:w-[76px] min-[1001px]:px-3 min-[1001px]:pt-6 min-[1001px]:pb-4',
        collapsed && 'min-[821px]:w-[52px] min-[821px]:px-1',
        hidden && 'hidden',
      )}
      aria-label="Spaces"
      inert={screen === 'share'}
    >
      <a
        className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground min-[481px]:size-11 min-[481px]:rounded-2xl [&_svg]:size-6 min-[481px]:[&_svg]:size-7"
        href="/"
        aria-label="Bettercomms home"
      >
        <AudioLines />
      </a>
      <div className="my-1 h-px w-6 bg-border" />
      <button
        className={cn(railButton, 'bg-accent font-bold text-accent-foreground hover:bg-accent/80')}
        onClick={onFriends}
        aria-label="Friends"
      >
        <Users size={22} />
      </button>
      {rooms.slice(0, 5).map((candidate) => (
        <button
          key={candidate.id}
          className={cn(
            railButton,
            'font-bold',
            room?.id === candidate.id && 'bg-accent text-accent-foreground',
          )}
          onClick={() => onSelectRoom(candidate)}
          title={roomLabel(candidate)}
        >
          {initials(roomLabel(candidate))}
        </button>
      ))}
      <button
        className={cn(railButton, 'border border-dashed')}
        aria-label="Create a space"
        onClick={onCreateRoom}
      >
        <Plus />
      </button>
      <button
        className={cn(railButton, screen === 'recordings' && 'bg-accent text-accent-foreground')}
        aria-current={screen === 'recordings' ? 'page' : undefined}
        aria-label="Recordings"
        title="Recordings"
        onClick={onRecordings}
      >
        <Clapperboard size={21} />
      </button>
      <div className="mt-auto flex flex-col items-center gap-4">
        <button
          className={cn(railButton, screen === 'settings' && 'bg-accent text-accent-foreground')}
          aria-current={screen === 'settings' ? 'page' : undefined}
          aria-label="Audio and video settings"
          onClick={onSettings}
        >
          <Settings2 size={21} />
        </button>
        {user ? (
          <Avatar name={user.name} />
        ) : (
          <span className="size-1.5 rounded-full bg-primary" />
        )}
      </div>
    </nav>
  );
}
