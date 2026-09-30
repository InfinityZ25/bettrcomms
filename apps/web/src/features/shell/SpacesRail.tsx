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
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Screen } from './useScreenRoute';
import type { Section } from './sections';

const railButton = 'size-10 rounded-2xl min-[481px]:size-11';
// Portrait phones: a labelled tab, sized for a thumb rather than a pointer.
const tabButton =
  'max-[820px]:h-12 max-[820px]:w-auto max-[820px]:min-w-0 max-[820px]:flex-1 max-[820px]:flex-col max-[820px]:gap-0.5 max-[820px]:rounded-xl max-[820px]:px-1';

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
  mobileDestination,
  home,
  friendsOpen,
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
  mobileDestination: Section | 'home' | null;
  home: boolean;
  friendsOpen: boolean;
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
  const { isMobile } = useSidebar();
  const inSection = (candidate: Section) =>
    screen === 'call' &&
    !home &&
    !friendsOpen &&
    (isMobile && mobileDestination
      ? mobileDestination === candidate
      : section === candidate);
  // On a phone each section opens its full-screen list.
  const openSection = (candidate: Section) => {
    onSection(candidate);
  };

  return (
    <nav
      className={cn(
        'space-rail flex w-[54px] shrink-0 flex-col items-center gap-2 bg-sidebar px-1 py-3 min-[481px]:w-[62px] min-[481px]:px-2 min-[1001px]:w-[68px] min-[1001px]:py-4',
        'max-[820px]:w-full max-[820px]:flex-row max-[820px]:gap-1 max-[820px]:border-t max-[820px]:border-border/60 max-[820px]:px-2 max-[820px]:pt-1 max-[820px]:pb-[max(0.25rem,env(safe-area-inset-bottom))]',
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
      <RailButton
        label="Bettercomms home"
        tab="Home"
        onClick={onHome}
        solid
        current={home && !friendsOpen}
      >
        <AudioLines />
      </RailButton>
      <SidebarTrigger
        className={cn(railButton, 'text-muted-foreground max-[820px]:hidden')}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
      />
      <Separator className="my-1 w-6 max-[820px]:hidden" />

      <RailButton
        label="Messages"
        current={inSection('messages') || (isMobile && friendsOpen)}
        onClick={() => openSection('messages')}
      >
        <MessageSquare size={21} />
      </RailButton>
      {!isMobile && (
        <RailButton label="Friends" onClick={onFriends} current={friendsOpen}>
          <Users size={21} />
        </RailButton>
      )}
      <RailButton
        label="Calls"
        current={inSection('calls')}
        onClick={() => openSection('calls')}
      >
        <Phone size={20} />
      </RailButton>
      <div className="phone:hidden">
        <RailButton
          label="Recordings"
          current={screen === 'recordings'}
          onClick={onRecordings}
        >
          <Clapperboard size={21} />
        </RailButton>
      </div>

      <div className="mt-auto flex flex-col items-center max-[820px]:mt-0 max-[820px]:flex-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  railButton,
                  'rounded-full max-[820px]:h-12 max-[820px]:w-full max-[820px]:flex-col max-[820px]:gap-0.5',
                )}
                aria-label={
                  user ? `${user.name} and account options` : 'Account options'
                }
              />
            }
          >
            {user ? (
              <Avatar
                name={user.name}
                id={user.id}
                src={user.avatar_url}
                prefer={ownFace}
              />
            ) : (
              <span className="size-2 rounded-full bg-primary" />
            )}
            <span className="hidden text-[0.6875rem] leading-none font-medium max-[820px]:block">
              You
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side={isMobile ? 'top' : 'left'}
            className="w-52"
          >
            {/* The label is a group label: Base UI requires it inside a group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate">
                {user?.name ?? 'Not signed in'}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onRecordings}
              className="hidden min-h-11 phone:flex"
            >
              <Clapperboard /> Recordings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSettings} className="phone:min-h-11">
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
  tab = label,
  current = false,
  solid = false,
  onClick,
  children,
}: {
  label: string;
  /** The shorter name printed under the icon in the phone tab bar. */
  tab?: string;
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
              tabButton,
              solid &&
                'shadow-lg shadow-primary/15 max-[820px]:bg-transparent max-[820px]:text-foreground max-[820px]:shadow-none',
              current && 'bg-accent text-accent-foreground',
            )}
            aria-label={label}
            aria-current={current ? 'page' : undefined}
            onClick={onClick}
          />
        }
      >
        {children}
        <span
          className="hidden text-[0.6875rem] leading-none font-medium max-[820px]:block"
          aria-hidden="true"
        >
          {tab}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
