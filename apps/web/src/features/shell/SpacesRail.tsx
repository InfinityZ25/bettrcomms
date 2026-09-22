import {
  AudioLines,
  Clapperboard,
  LogOut,
  MessageSquare,
  Phone,
  Settings2,
  Users,
} from 'lucide-react';
import { Avatar } from '@/components/avatar';
import { useOwnFace } from '@/features/settings/blobatarIdentity';
import type { User } from '@/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Screen } from './useScreenRoute';
import type { Section } from './sections';

const railButton = 'size-10 rounded-2xl min-[481px]:size-11';

/**
 * The icon rail: where you are in the application.
 *
 * It holds sections, not contents. Which rooms and conversations exist is the
 * sidebar's business; the rail only says which of them the sidebar is showing.
 * Rooms used to appear here as well, which meant the same list in two places
 * and no room for anything else.
 */
export default function SpacesRail({
  user,
  screen,
  section,
  collapsed,
  hidden,
  onSection,
  onFriends,
  onRecordings,
  onSettings,
  onSignOut,
  onHome,
}: {
  user: User | null;
  screen: Screen;
  section: Section;
  collapsed: boolean;
  hidden: boolean;
  onSection: (section: Section) => void;
  onFriends: () => void;
  onRecordings: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  onHome: () => void;
}) {
  // A section button is current when the sidebar is showing it and no other
  // screen has taken over.
  const ownFace = useOwnFace();
  const inSection = (candidate: Section) =>
    screen === 'call' && section === candidate;

  return (
    <nav
      className={cn(
        'space-rail flex w-[54px] shrink-0 flex-col items-center gap-2 bg-sidebar px-1 py-3 min-[481px]:w-[62px] min-[481px]:px-2 min-[1001px]:w-[68px] min-[1001px]:py-4',
        collapsed && 'min-[821px]:w-[52px] min-[821px]:px-1',
        hidden && 'hidden',
      )}
      aria-label="Sections"
      inert={screen === 'share'}
    >
      {/*
        A button, not a link. An <a href="/"> is a real navigation: the browser
        throws the document away and builds it again, which in the desktop shell
        tears down the call, its media engine and every socket with it. Returning
        home is a state change, and it is made as one.
      */}
      <RailButton label="Bettercomms home" onClick={onHome} solid>
        <AudioLines />
      </RailButton>
      <SidebarTrigger
        className={cn(railButton, 'text-muted-foreground')}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
      />
      <Separator className="my-1 w-6" />

      <RailButton
        label="Messages"
        current={inSection('messages')}
        onClick={() => onSection('messages')}
      >
        <MessageSquare size={21} />
      </RailButton>
      <RailButton label="Friends" onClick={onFriends}>
        <Users size={21} />
      </RailButton>
      <RailButton
        label="Calls"
        current={inSection('calls')}
        onClick={() => onSection('calls')}
      >
        <Phone size={20} />
      </RailButton>
      <RailButton
        label="Recordings"
        current={screen === 'recordings'}
        onClick={onRecordings}
      >
        <Clapperboard size={21} />
      </RailButton>

      <div className="mt-auto flex flex-col items-center">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className={cn(railButton, 'rounded-full')}
                aria-label={user ? `${user.name} and account options` : 'Account options'}
              />
            }
          >
            {user ? (
              <Avatar name={user.name} id={user.id} src={user.avatar_url} prefer={ownFace} />
            ) : (
              <span className="size-2 rounded-full bg-primary" />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="left" className="w-52">
            {/* The label is a group label: Base UI requires it inside a group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate">
                {user?.name ?? 'Not signed in'}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSettings}>
              <Settings2 /> Settings
            </DropdownMenuItem>
            {user && (
              <DropdownMenuItem variant="destructive" onClick={onSignOut}>
                <LogOut /> Sign out
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}

/**
 * One rail icon.
 *
 * The rail is icons alone, so each carries its name for anything that cannot
 * see it and shows the same name on hover to anyone who can.
 */
function RailButton({
  label,
  current = false,
  solid = false,
  onClick,
  children,
}: {
  label: string;
  current?: boolean;
  solid?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={solid ? 'default' : 'ghost'}
            size="icon"
            className={cn(
              railButton,
              solid && 'shadow-lg shadow-primary/15',
              current && 'bg-accent text-accent-foreground',
            )}
            aria-label={label}
            aria-current={current ? 'page' : undefined}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
