import { Headphones, Plus } from 'lucide-react';
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
import RoomNavigation, { roomLabel } from '@/features/rooms/RoomNavigation';
import type { CallParticipant, Room, User } from '@/api';
import type { Screen } from './useScreenRoute';
import type { Section } from './sections';
import { motion } from 'motion/react';
import { softSpring } from '@/lib/motion';

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
  onRoomSettings: (room: Room) => void;
  onInviteToRoom: (room: Room) => void;
  onRoomsChanged: () => void;
  onError: (message: string) => void;
}) {
  const { open } = useSidebar();
  // Being in a call used to hide this outright. Whether the room list is on
  // screen is the reader's choice, made with the toggle, and a call is not a
  // reason to take it away from them; full-focus mode still hides everything,
  // because that is what asking for it means.
  const visible = open && !hidden;

  const messages = section === 'messages';
  const listed = rooms.filter(
    (candidate) => (candidate.kind ?? 'channel') === (messages ? 'direct' : 'channel'),
  );
  // The profile belongs to the conversation you are in, not to whatever is
  // selected elsewhere: a room selected in Calls is not a person.
  const conversation =
    messages && room && (room.kind ?? 'channel') === 'direct' ? room : null;

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
        <SidebarHeader className="px-3 pt-3 pb-1">
          <h2 className="font-heading text-sm font-semibold tracking-tight">
            {messages ? 'Messages' : 'Calls'}
          </h2>
          <p className="text-[0.65rem] leading-4 text-muted-foreground">
            {messages
              ? 'Your direct conversations.'
              : 'Rooms you and your friends call in.'}
          </p>
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
              onSelect={onSelectRoom}
              onCreate={onCreateRoom}
              onRoomSettings={onRoomSettings}
              onInviteToRoom={onInviteToRoom}
              onRoomsChanged={onRoomsChanged}
              onError={onError}
            />
          ) : (
            <Empty messages={messages} onCreateRoom={onCreateRoom} />
          )}
        </SidebarContent>
      </Sidebar>
    </motion.div>
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
      <strong className="mt-2 block truncate text-sm font-semibold">{name}</strong>
      {known && callers.length > 0 ? (
        <Badge className="mt-2 h-5 gap-1 px-1.5">
          <Headphones size={12} />
          In a call
        </Badge>
      ) : (
        <span className="mt-1 block text-[0.65rem] text-muted-foreground">
          Direct message
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
