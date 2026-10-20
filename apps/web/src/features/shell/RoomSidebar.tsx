import { openMessageSearch } from '@/features/chat/searchEvents';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Headphones, Link, Plus, Search, X } from 'lucide-react';
import ConversationAvatar from '@/features/chat/ConversationAvatar';
import { Mascot } from '@/components/mascot';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import RoomNavigation, { roomLabel } from '@/features/rooms/RoomNavigation';
import type { CallParticipant, Room, User } from '@/api';
import type { Screen } from './useScreenRoute';
import { isConversationRoom, type Section } from './sections';
import { motion } from 'motion/react';
import { softSpring } from '@/lib/motion';
import {
  conversationPreferencesSnapshot,
  refreshConversationPreferences,
  subscribeConversationPreferences,
} from '@/features/rooms/conversationPreferences';
import ConversationArchiveFilter from '@/features/rooms/ConversationArchiveFilter';

/**
 * The sidebar shows whichever section the rail has selected.
 *
 * It used to open with a "Your space" button that did nothing and a Friends
 * entry that now lives in the rail, and then listed rooms and direct messages
 * together regardless of where you were. Now the rail says what you are looking
 * at and this shows it: rooms to call in, or conversations with people — and
 * for a conversation, who it is with.
 */
export default function RoomSidebar({
  rooms,
  room,
  user,
  section,
  presence,
  presenceKnown,
  screen,
  hidden,
  onSelectRoom,
  onCreateRoom,
  onCreateGroup,
  onJoinInvitation,
  onRoomSettings,
  onInviteToRoom,
  onRoomsChanged,
  onError,
}: {
  rooms: Room[];
  room: Room | null;
  user: User | null;
  section: Section;
  presence: Record<string, CallParticipant[]>;
  presenceKnown: boolean;
  screen: Screen;
  hidden: boolean;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: () => void;
  onCreateGroup: () => void;
  onJoinInvitation: () => void;
  onRoomSettings: (room: Room) => void;
  onInviteToRoom: (room: Room) => void;
  onRoomsChanged: () => void;
  onError: (message: string) => void;
}) {
  const { open, openMobile, setOpenMobile, isMobile } = useSidebar();
  const [archived, setArchived] = useState(false);
  const preferenceState = useSyncExternalStore(
    subscribeConversationPreferences,
    conversationPreferencesSnapshot,
  );
  const preferences =
    preferenceState.userId === user?.id ? preferenceState.preferences : {};
  // Being in a call used to hide this outright. Whether the room list is on
  // screen is the reader's choice, made with the toggle, and a call is not a
  // reason to take it away from them; full-focus mode still hides everything,
  // because that is what asking for it means.
  const visible = open && !hidden;
  useEffect(() => {
    if (!isMobile || hidden || screen === 'share') setOpenMobile(false);
  }, [hidden, isMobile, screen, setOpenMobile]);

  const messages = section === 'messages';
  const listed = rooms.filter((candidate) =>
    messages
      ? isConversationRoom(candidate.kind) &&
        Boolean(preferences[candidate.id]?.archived) === archived
      : !isConversationRoom(candidate.kind),
  );
  // The profile belongs to the conversation you are in, not to whatever is
  // selected elsewhere: a room selected in Calls is not a person.
  const conversation =
    messages && room && isConversationRoom(room.kind) ? room : null;

  const sidebarContent = (
    <>
      <SidebarHeader className="gap-2.5 px-3 pt-3 pb-2 phone:pr-10">
        {user && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-full justify-start gap-2 rounded-xl border-border bg-background/45 px-3 text-[0.8125rem] font-normal text-muted-foreground shadow-[var(--highlight)] hover:border-foreground/15 hover:bg-background/80 hover:text-foreground dark:hover:bg-background/80 phone:h-11"
            onClick={() => {
              setOpenMobile(false);
              openMessageSearch();
            }}
            aria-label="Search all messages"
          >
            <Search size={14} />
            Search messages
            <kbd
              aria-hidden="true"
              className="ml-auto hidden h-5 items-center rounded-md border border-border bg-sidebar-accent px-1.5 font-sans text-[0.6875rem] font-medium text-muted-foreground min-[1400px]:inline-flex"
            >
              Ctrl ⇧ F
            </kbd>
          </Button>
        )}
        <div className="flex items-center justify-between pt-1">
          <h2 className="font-heading text-lg leading-tight font-bold tracking-tight">
            {messages ? 'Messages' : 'Rooms'}
          </h2>
          {!messages && user && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground dark:hover:bg-sidebar-accent phone:size-11"
              aria-label="Create room"
              onClick={() => {
                setOpenMobile(false);
                onCreateRoom();
              }}
            >
              <Plus size={16} />
            </Button>
          )}
        </div>
        <p className="-mt-2 text-[0.6875rem] leading-4 text-muted-foreground">
          {messages
            ? 'Your private conversations.'
            : 'Channels for text, voice and your friends.'}
        </p>
        {user && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-full justify-start gap-2 rounded-xl bg-sidebar-accent/70 px-3 text-[0.8125rem] text-foreground hover:bg-sidebar-accent dark:hover:bg-sidebar-accent [&_svg]:text-primary phone:h-11"
            aria-label={messages ? 'New group message' : 'Join with invitation'}
            onClick={() => {
              setOpenMobile(false);
              if (messages) onCreateGroup();
              else onJoinInvitation();
            }}
          >
            {messages ? <Plus size={14} /> : <Link size={14} />}
            {messages ? 'New group' : 'Join with link'}
          </Button>
        )}
        {messages && user && (
          <ConversationArchiveFilter
            archived={archived}
            count={
              rooms.filter(
                (item) =>
                  isConversationRoom(item.kind) &&
                  preferences[item.id]?.archived,
              ).length
            }
            onChange={setArchived}
          />
        )}
        {preferenceState.error && (
          <p role="alert" className="text-xs text-destructive">
            {preferenceState.error}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refreshConversationPreferences()}
            >
              Retry
            </Button>
          </p>
        )}
      </SidebarHeader>

      <SidebarContent className="px-1">
        {conversation && (
          <ConversationProfile
            room={conversation}
            callers={presence[conversation.id] ?? []}
            known={presenceKnown}
          />
        )}
        {listed.length ? (
          <RoomNavigation
            rooms={listed}
            kind={messages ? 'direct' : 'channel'}
            user={user}
            selected={room?.id}
            presence={presence}
            known={presenceKnown}
            onSelect={(next) => {
              setOpenMobile(false);
              onSelectRoom(next);
            }}
            onCreate={() => {
              setOpenMobile(false);
              onCreateRoom();
            }}
            onRoomSettings={(next) => {
              setOpenMobile(false);
              onRoomSettings(next);
            }}
            onInviteToRoom={(next) => {
              setOpenMobile(false);
              onInviteToRoom(next);
            }}
            onRoomsChanged={onRoomsChanged}
            onError={onError}
          />
        ) : archived && messages ? (
          <p className="mx-2 mt-2 rounded-xl border border-dashed border-border p-4 text-xs leading-5 text-muted-foreground animate-bc-rise">
            No archived conversations. Archiving keeps your membership and
            messages; it does not mute alerts.
          </p>
        ) : (
          <Empty
            messages={messages}
            onCreateRoom={() => {
              setOpenMobile(false);
              onCreateRoom();
            }}
          />
        )}
      </SidebarContent>
    </>
  );

  return (
    <>
      {/* A phone, portrait or on its side, gets the drawer below instead. */}
      {!isMobile && (
        <motion.div
          className="h-full shrink-0 overflow-hidden [--room-sidebar-width:186px] min-[1251px]:[--room-sidebar-width:210px] min-[1400px]:[--room-sidebar-width:248px]"
          initial={false}
          animate={{
            width: visible ? 'var(--room-sidebar-width)' : 0,
            opacity: visible ? 1 : 0,
          }}
          transition={softSpring}
          aria-hidden={!visible}
        >
          <Sidebar
            aria-label="Conversations"
            collapsible="none"
            className="sidebar h-full w-(--room-sidebar-width) shrink-0 rounded-2xl bg-transparent [--avatar-ring:var(--sidebar)]"
            inert={screen === 'share' || !visible}
          >
            {sidebarContent}
          </Sidebar>
        </motion.div>
      )}
      <Sheet
        open={openMobile && !hidden && screen !== 'share'}
        onOpenChange={setOpenMobile}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          className="bg-sidebar p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
          style={{ width: 'min(85vw, 24rem)', maxWidth: 'none' }}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Conversations</SheetTitle>
            <SheetDescription>Rooms and direct messages.</SheetDescription>
          </SheetHeader>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-[calc(env(safe-area-inset-top)+0.5rem)] right-2 z-10 rounded-xl text-muted-foreground hover:text-foreground"
            aria-label="Close sidebar"
            onClick={() => setOpenMobile(false)}
          >
            <X size={16} />
          </Button>
          <Sidebar
            aria-label="Conversations"
            collapsible="none"
            className="sidebar h-full w-full min-w-0 rounded-l-2xl bg-sidebar [--avatar-ring:var(--sidebar)]"
            inert={screen === 'share'}
          >
            {sidebarContent}
          </Sidebar>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Who a direct conversation is with.
 *
 * The room supplies its label and a neutral conversation icon. Call presence
 * only says whether a call is running, so it does not invent the person's
 * account-wide availability or start a member lookup for this sidebar.
 */
function ConversationProfile({
  room,
  callers,
  known,
}: {
  room: Room;
  callers: CallParticipant[];
  known: boolean;
}) {
  const name = roomLabel(room);
  return (
    <section
      className="relative mx-2 mt-1 mb-2 overflow-hidden rounded-2xl border border-border bg-sidebar-accent/45 px-3 pt-5 pb-4 text-center shadow-[var(--highlight)] animate-bc-rise"
      aria-label={`About ${name}`}
    >
      {/* A banner of the brand's colours behind the face, as on a profile. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-16 bc-brand-gradient opacity-30 [mask-image:linear-gradient(to_bottom,black,transparent)]"
      />
      <div className="relative flex justify-center">
        <ConversationAvatar
          room={room}
          className="size-16 drop-shadow-[0_8px_18px_oklch(0_0_0/0.35)]"
        />
      </div>
      <strong className="relative mt-2.5 block truncate font-heading text-base leading-tight font-bold">
        {name}
      </strong>
      {known && callers.length > 0 ? (
        <Badge className="relative mt-2 h-5 gap-1.5 bg-online/15 px-2 text-foreground ring-1 ring-online/35 dark:text-online">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-online animate-bc-pulse"
          />
          <Headphones size={12} />
          In a call
        </Badge>
      ) : (
        <span className="relative mt-1 block text-[0.6875rem] text-muted-foreground">
          {room.kind === 'group' ? 'Group message' : 'Direct message'}
        </span>
      )}
    </section>
  );
}

function Empty({
  messages,
  onCreateRoom,
}: {
  messages: boolean;
  onCreateRoom: () => void;
}) {
  return (
    <div className="mx-2 mt-2 flex flex-col items-start rounded-2xl border border-dashed border-border px-3 py-4 animate-bc-rise">
      <Mascot className="mb-3 w-14 animate-bc-float" />
      <p className="text-xs leading-5 text-muted-foreground">
        {messages
          ? 'No conversations yet. Add a friend to start one.'
          : 'Create a room to bring your friends together.'}
      </p>
      {!messages && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3 w-full rounded-xl"
          onClick={onCreateRoom}
        >
          <Plus size={15} /> New room
        </Button>
      )}
    </div>
  );
}
