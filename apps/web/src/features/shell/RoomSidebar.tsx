import { openMessageSearch } from '@/features/chat/searchEvents';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Headphones, Link, Plus, Search, X } from 'lucide-react';
import { Avatar } from '@/components/avatar';
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
import { conversationPreferencesSnapshot, refreshConversationPreferences, subscribeConversationPreferences } from '@/features/rooms/conversationPreferences';
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
  const preferenceState = useSyncExternalStore(subscribeConversationPreferences, conversationPreferencesSnapshot);
  const preferences = preferenceState.userId === user?.id ? preferenceState.preferences : {};
  // Being in a call used to hide this outright. Whether the room list is on
  // screen is the reader's choice, made with the toggle, and a call is not a
  // reason to take it away from them; full-focus mode still hides everything,
  // because that is what asking for it means.
  const visible = open && !hidden;
  useEffect(() => {
    if (!isMobile || hidden || screen === 'share') setOpenMobile(false);
  }, [hidden, isMobile, screen, setOpenMobile]);

  const messages = section === 'messages';
  const listed = rooms.filter(
    (candidate) =>
      messages ? isConversationRoom(candidate.kind) && Boolean(preferences[candidate.id]?.archived) === archived : !isConversationRoom(candidate.kind),
  );
  // The profile belongs to the conversation you are in, not to whatever is
  // selected elsewhere: a room selected in Calls is not a person.
  const conversation =
    messages && room && isConversationRoom(room.kind) ? room : null;

  const sidebarContent = (
    <>
      <SidebarHeader className="px-3 pt-3 pb-1 max-[820px]:pr-10">
        {user && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpenMobile(false);
              openMessageSearch();
            }}
            aria-label="Search all messages"
          >
            <Search size={14} />
            Search messages
          </Button>
        )}
        <h2 className="font-heading text-sm font-semibold tracking-tight">
          {messages ? 'Messages' : 'Calls'}
        </h2>
        <p className="text-[0.65rem] leading-4 text-muted-foreground">
          {messages
            ? 'Your private conversations.'
            : 'Rooms you and your friends call in.'}
        </p>
        {user && <Button variant="ghost" size="sm" aria-label={messages ? 'New group message' : 'Join with invitation'} onClick={() => { setOpenMobile(false); if (messages) onCreateGroup(); else onJoinInvitation(); }}>
          {messages ? <Plus size={14} /> : <Link size={14} />}{messages ? 'New group' : 'Join with link'}
        </Button>}
        {messages && user && <ConversationArchiveFilter archived={archived} count={rooms.filter((item) => isConversationRoom(item.kind) && preferences[item.id]?.archived).length} onChange={setArchived} />}
        {preferenceState.error && <p role="alert" className="text-xs text-destructive">{preferenceState.error}<Button size="sm" variant="ghost" onClick={() => void refreshConversationPreferences()}>Retry</Button></p>}
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
        ) : archived && messages ? <p className="p-4 text-xs text-muted-foreground">No archived conversations. Archiving keeps your membership and messages; it does not mute alerts.</p> : (
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
      {!isMobile && <motion.div
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
          className="sidebar h-full w-(--room-sidebar-width) shrink-0 rounded-2xl bg-sidebar"
          inert={screen === 'share' || !visible}
        >
          {sidebarContent}
        </Sidebar>
      </motion.div>}
      <Sheet open={openMobile && !hidden && screen !== 'share'} onOpenChange={setOpenMobile}>
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
            className="absolute top-[calc(env(safe-area-inset-top)+0.5rem)] right-2 z-10"
            aria-label="Close sidebar"
            onClick={() => setOpenMobile(false)}
          >
            <X size={16} />
          </Button>
          <Sidebar
            aria-label="Conversations"
            collapsible="none"
            className="sidebar h-full w-full min-w-0 rounded-l-2xl bg-sidebar"
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
 * Only what the room itself carries is shown. A conversation knows the other
 * person's display name, and presence knows whether they are in a call right
 * now; anything more — an email, a real presence state — is not on this side of
 * the API, and inventing it would be worse than leaving it out.
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
      className="mx-1 mt-2 mb-1 rounded-2xl bg-sidebar-accent/50 px-3 py-4 text-center"
      aria-label={`About ${name}`}
    >
      <div className="flex justify-center">
        <Avatar name={name} />
      </div>
      <strong className="mt-2 block truncate text-sm font-semibold">
        {name}
      </strong>
      {known && callers.length > 0 ? (
        <Badge className="mt-2 h-5 gap-1 px-1.5">
          <Headphones size={12} />
          In a call
        </Badge>
      ) : (
        <span className="mt-1 block text-[0.65rem] text-muted-foreground">
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
    <div className="px-3 py-4">
      <Mascot className="mb-2 w-12" />
      <p className="text-xs leading-5 text-muted-foreground">
        {messages
          ? 'No conversations yet. Add a friend to start one.'
          : 'Create a room to bring your friends together.'}
      </p>
      {!messages && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3 w-full"
          onClick={onCreateRoom}
        >
          <Plus size={15} /> New room
        </Button>
      )}
    </div>
  );
}
