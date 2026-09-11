import { ChevronDown, Settings2, Users } from 'lucide-react';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenuButton, useSidebar } from '@/components/ui/sidebar';
import RoomNavigation from '@/features/rooms/RoomNavigation';
import type { CallParticipant, Room, User } from '@/api';
import type { Screen } from './useScreenRoute';
import { motion } from 'motion/react';
import { softSpring } from '@/lib/motion';

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
  const { open } = useSidebar();
  const visible = open && !hiddenInCall && !hidden;
  return (
    <motion.div
      className="hidden h-full shrink-0 overflow-hidden min-[821px]:block [--room-sidebar-width:186px] min-[1251px]:[--room-sidebar-width:210px] min-[1400px]:[--room-sidebar-width:248px]"
      initial={false}
      animate={{
        width: visible ? 'var(--room-sidebar-width)' : 0,
        opacity: visible ? 1 : 0,
      }}
      transition={softSpring}
      aria-hidden={!visible}
    >
      <Sidebar
        collapsible="none"
        className="sidebar h-full w-(--room-sidebar-width) shrink-0 rounded-2xl bg-sidebar"
        inert={screen === 'share' || !visible}
      >
      <SidebarHeader className="px-2 pt-2 pb-1">
        <Button variant="ghost" className="h-11 w-full justify-start px-3 font-semibold text-foreground">
          <span className="grid size-7 place-items-center rounded-lg bg-primary text-[0.65rem] font-bold text-primary-foreground">BC</span>
          <span className="min-w-0 flex-1 truncate text-left">Your space</span>
          <ChevronDown size={15} />
        </Button>
        <SidebarMenuButton onClick={onFriends} isActive={screen === 'call' && !room}>
          <Users /> <span className="flex-1">Friends</span>
          <span className="text-[0.65rem] text-muted-foreground">⌘F</span>
        </SidebarMenuButton>
      </SidebarHeader>
      <SidebarContent className="px-1">
        <RoomNavigation
          rooms={rooms}
          selected={room?.id}
          presence={presence}
          known={presenceKnown}
          onSelect={onSelectRoom}
          onCreate={onCreateRoom}
        />
      </SidebarContent>
      <SidebarFooter className="px-2 pb-2">
        <Separator />
        <div className="flex min-w-0 items-center gap-2.5 rounded-xl p-2 hover:bg-sidebar-accent/70">
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
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Settings"
          onClick={onSettings}
        >
          <Settings2 size={18} />
        </Button>
        </div>
      </SidebarFooter>
      </Sidebar>
    </motion.div>
  );
}
