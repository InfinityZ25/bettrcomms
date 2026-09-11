import { AudioLines, Clapperboard, Plus, Settings2, Users } from 'lucide-react';
import { Avatar, initials } from '@/components/avatar';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import type { Room, User } from '@/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import type { Screen } from './useScreenRoute';

const railButton = 'size-10 rounded-2xl min-[481px]:size-11';

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
  onHome,
  settingsOpen,
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
  onHome: () => void;
  /** Settings is a dialog, so its button reads its own state, not the screen. */
  settingsOpen: boolean;
}) {
  return (
    <nav
      className={cn(
        'space-rail flex w-[54px] shrink-0 flex-col items-center gap-2 bg-sidebar px-1 py-3 min-[481px]:w-[62px] min-[481px]:px-2 min-[1001px]:w-[68px] min-[1001px]:py-4',
        collapsed && 'min-[821px]:w-[52px] min-[821px]:px-1',
        hidden && 'hidden',
      )}
      aria-label="Spaces"
      inert={screen === 'share'}
    >
      {/*
        A button, not a link. An <a href="/"> is a real navigation: the browser
        throws the document away and builds it again, which in the desktop shell
        tears down the call, its media engine and every socket with it. Returning
        to the call screen is a state change, and it is made as one.
      */}
      <Button
        size="icon"
        className={cn(railButton, 'shadow-lg shadow-primary/15')}
        onClick={onHome}
        aria-label="Bettercomms home"
      >
        <AudioLines />
      </Button>
      <SidebarTrigger
        className={cn(railButton, 'text-muted-foreground')}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
      />
      <Separator className="my-1 w-6" />
      <Button
        variant="ghost"
        size="icon"
        className={cn(railButton, 'bg-sidebar-accent text-sidebar-accent-foreground')}
        onClick={onFriends}
        aria-label="Friends"
      >
        <Users size={22} />
      </Button>
      {rooms.slice(0, 5).map((candidate) => (
        <Button
          key={candidate.id}
          variant="ghost"
          size="icon"
          className={cn(
            railButton,
            'font-bold',
            room?.id === candidate.id && 'bg-accent text-accent-foreground',
          )}
          onClick={() => onSelectRoom(candidate)}
          title={roomLabel(candidate)}
        >
          {initials(roomLabel(candidate))}
        </Button>
      ))}
      <Button
        variant="ghost"
        size="icon"
        className={cn(railButton, 'border border-dashed border-sidebar-border')}
        aria-label="Create a space"
        onClick={onCreateRoom}
      >
        <Plus />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn(railButton, screen === 'recordings' && 'bg-accent text-accent-foreground')}
        aria-current={screen === 'recordings' ? 'page' : undefined}
        aria-label="Recordings"
        title="Recordings"
        onClick={onRecordings}
      >
        <Clapperboard size={21} />
      </Button>
      <div className="mt-auto flex flex-col items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          className={cn(railButton, settingsOpen && 'bg-accent text-accent-foreground')}
          aria-expanded={settingsOpen}
          aria-label="Audio and video settings"
          onClick={onSettings}
        >
          <Settings2 size={21} />
        </Button>
        {user ? (
          <Avatar name={user.name} />
        ) : (
          <span className="size-1.5 rounded-full bg-primary" />
        )}
      </div>
    </nav>
  );
}
