import {
  Clapperboard,
  LogOut,
  MessageSquare,
  Phone,
  Settings2,
  Users,
  Inbox,
  UserRound,
  Bookmark,
  Bell,
  Search,
} from 'lucide-react';
import { Avatar } from '@/components/avatar';
import { BrandTile } from '@/components/brand-mark';
import { useOwnFace } from '@/features/settings/blobatarIdentity';
import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import AccountPresenceSelector from '@/features/settings/AccountPresenceSelector';
import {
  ownPresenceSnapshot,
  subscribeOwnPresence,
} from '@/features/settings/presenceStore';
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
import { openUserProfile } from '@/features/settings/ProfileDialog';
import { CustomStatusText } from '@/features/settings/CustomStatus';
import { openPersonalInbox } from '@/features/personal/inboxEvents';

// A circle that firms into a squircle under the pointer — the shape it keeps
// while it is the current section — with icons drawn at rail size, not row size.
const railButton =
  "size-10 rounded-2xl text-muted-foreground transition-[color,background-color,border-radius,box-shadow,transform] duration-200 ease-out min-[481px]:size-11 hover:rounded-xl hover:bg-sidebar-accent hover:text-foreground dark:hover:bg-sidebar-accent [&_svg:not([class*='size-'])]:size-5";
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
  onActivity,
  reminders,
  onQuickAccess,
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
  onActivity: () => void;
  reminders?: ReactNode;
  onQuickAccess: () => void;
}) {
  // A section button is current when the sidebar is showing it and no other
  // screen has taken over.
  const ownFace = useOwnFace();
  const ownPresence = useSyncExternalStore(
    subscribeOwnPresence,
    ownPresenceSnapshot,
  );
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
        // Transparent on the window frame, so the frame's glow runs behind the
        // rail unbroken. The gutter is the space between a button and the
        // rail's outer edge, where the current-section pill sits.
        'space-rail flex w-[54px] shrink-0 flex-col items-center gap-2 bg-transparent px-1 py-3 [--avatar-ring:var(--sidebar)] min-[821px]:w-[62px] min-[821px]:[--rail-gutter:9px] min-[481px]:px-2 min-[1001px]:w-[68px] min-[1001px]:py-4 min-[1001px]:[--rail-gutter:12px]',
        'max-[820px]:w-full max-[820px]:flex-row max-[820px]:gap-1 max-[820px]:border-t max-[820px]:border-border max-[820px]:bc-glass max-[820px]:px-2 max-[820px]:pt-1 max-[820px]:pb-[max(0.25rem,env(safe-area-inset-bottom))] max-[820px]:[--avatar-ring:var(--popover)]',
        collapsed &&
          'min-[821px]:w-[52px] min-[821px]:px-1 min-[821px]:[--rail-gutter:4px]',
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
        {/* The app icon is the way home. Its bars move while a call is live. */}
        <BrandTile
          live={collapsed}
          className="size-full transition-[border-radius,box-shadow,background-color] duration-200 ease-out group-hover/button:rounded-[24%] group-hover/button:shadow-[var(--glow-brand),0_0_0_4px_color-mix(in_oklch,var(--brand)_16%,transparent),inset_0_1px_0_oklch(1_0_0/0.4),inset_0_-1px_0_oklch(0_0_0/0.12)] max-[820px]:size-5 max-[820px]:bg-transparent max-[820px]:bg-none max-[820px]:text-current max-[820px]:shadow-none max-[820px]:group-hover/button:shadow-none max-[820px]:[&>svg]:size-full"
        />
      </RailButton>
      <SidebarTrigger
        className={cn(
          railButton,
          "text-muted-foreground [&_svg:not([class*='size-'])]:size-[18px] max-[820px]:hidden",
        )}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
      />
      <Separator className="my-1 w-6 rounded-full bg-border max-[820px]:hidden" />
      {user && <RailButton label="Quick access" tab="Find" onClick={onQuickAccess}><Search /></RailButton>}

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
      {user && !isMobile && (
        <RailButton label="Activity" onClick={onActivity}>
          <Inbox size={21} />
        </RailButton>
      )}
      <RailButton
        label="Rooms"
        current={inSection('calls')}
        onClick={() => openSection('calls')}
      >
        <Phone size={20} />
      </RailButton>
      {reminders}
      <div className="phone:hidden">
        <RailButton
          label="Recordings"
          current={screen === 'recordings'}
          onClick={onRecordings}
        >
          <Clapperboard size={21} />
        </RailButton>
      </div>

      <div className="mt-auto flex flex-col items-center max-[820px]:mt-0 max-[820px]:min-w-11 max-[820px]:flex-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  railButton,
                  'rounded-full hover:rounded-full aria-expanded:bg-sidebar-accent max-[820px]:h-12 max-[820px]:w-full max-[820px]:flex-col max-[820px]:gap-0.5 max-[820px]:rounded-xl max-[820px]:hover:rounded-xl',
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
                className="rounded-full bg-sidebar-accent/70 ring-2 ring-transparent ring-offset-2 ring-offset-transparent transition-shadow duration-200 group-hover/button:ring-primary/40 group-aria-expanded/button:ring-primary/60 min-[821px]:size-9"
                presence={
                  ownPresence.userId === user.id
                    ? ownPresence.status === 'invisible'
                      ? 'offline'
                      : ownPresence.status === 'idle'
                        ? 'away'
                        : ownPresence.status
                    : 'offline'
                }
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
            className="w-56"
          >
            {/* The label is a group label: Base UI requires it inside a group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate font-heading text-sm font-semibold tracking-normal text-foreground normal-case">
                {user?.name ?? 'Not signed in'}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {user && (
              <div className="px-2 py-2">
                <AccountPresenceSelector user={user} compact />
              </div>
            )}
            {user && (
              <div className="px-2 pb-2">
                <CustomStatusText userId={user.id} />
              </div>
            )}
            {user && (
              <DropdownMenuItem
                onClick={() => openUserProfile(user.id)}
                className="phone:min-h-11"
              >
                <UserRound /> View my profile
              </DropdownMenuItem>
            )}
            {user && (
              <DropdownMenuItem
                onClick={onActivity}
                className="min-h-11 phone:flex"
              >
                <Inbox /> Activity
              </DropdownMenuItem>
            )}
            {user && <DropdownMenuItem className="min-h-11" onClick={() => openPersonalInbox('saved')}><Bookmark />Saved items</DropdownMenuItem>}
            {user && <DropdownMenuItem className="min-h-11" onClick={() => openPersonalInbox('reminders')}><Bell />Reminders</DropdownMenuItem>}
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
  const { isMobile } = useSidebar();
  return (
    <Tooltip disabled={isMobile}>
      <TooltipTrigger
        render={
          <Button
            variant={solid ? 'default' : 'ghost'}
            size="icon"
            className={cn(
              railButton,
              tabButton,
              'relative',
              // The brand tile is the button's face; the button itself only
              // keeps its focus ring and, as a phone tab, the tab's colours.
              solid &&
                'bg-transparent shadow-none hover:bg-transparent hover:shadow-none dark:hover:bg-transparent max-[820px]:text-muted-foreground max-[820px]:hover:text-foreground',
              current &&
                !solid &&
                'rounded-xl bg-primary/12 text-primary hover:rounded-xl hover:bg-primary/15 hover:text-primary dark:hover:bg-primary/15',
              current &&
                'max-[820px]:bg-primary/10 max-[820px]:text-primary max-[820px]:hover:bg-primary/10 max-[820px]:hover:text-primary',
            )}
            aria-label={label}
            aria-current={current ? 'page' : undefined}
            onClick={onClick}
          />
        }
      >
        {children}
        <span
          className={cn(
            'hidden text-[0.6875rem] leading-none font-medium max-[820px]:block',
            current && 'max-[820px]:font-semibold',
          )}
          aria-hidden="true"
        >
          {tab}
        </span>
        {/*
          Where you are, on the rail's outer edge: a pill that peeks out under
          the pointer and stands full height beside the current section. A
          phone tab bar carries it along its top edge instead.
        */}
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute top-1/2 right-[calc(var(--rail-gutter,0px)*-1)] h-0 w-1 -translate-y-1/2 rounded-l-full bg-primary opacity-0 transition-[height,width,opacity] duration-200 ease-out group-hover/button:h-2.5 group-hover/button:opacity-100',
            'max-[820px]:-top-1 max-[820px]:right-auto max-[820px]:left-1/2 max-[820px]:h-[3px] max-[820px]:w-0 max-[820px]:-translate-x-1/2 max-[820px]:translate-y-0 max-[820px]:rounded-full max-[820px]:group-hover/button:h-[3px]',
            current &&
              'h-6 opacity-100 group-hover/button:h-6 max-[820px]:w-6',
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
