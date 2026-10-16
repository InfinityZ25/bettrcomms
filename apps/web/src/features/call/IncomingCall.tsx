import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import type { CallParticipant, Room, User } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { clearDesktopNotification, notifyDesktop } from '@/desktop/notifications';
import { notificationSnapshot, roomIsMuted, subscribeNotifications } from '@/features/chat/notificationSettings';
import { isConversationRoom } from '@/features/shell/sections';
import { loopSound, stopSound } from '@/media/sounds';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import { useActiveCall } from './CallSessionContext';

/** Long enough to reach the desk, short enough not to become the office joke. */
const GIVE_UP_AFTER = 30_000;

/**
 * Somebody is calling you.
 *
 * Only a direct conversation rings. A room with a call in it is a place you
 * can walk into, and a door that rings every time somebody walks through it is
 * a door nobody keeps.
 *
 * Ringing is a transition, not a state: a call has to *start* while you are
 * not in it. Watching the state instead is what made hanging up ring at you —
 * the moment you left, a call with people still in it looked exactly like an
 * incoming one.
 */
export default function IncomingCall({
  user,
  rooms,
  presence,
  onAnswer,
}: {
  user: User | null;
  /** Every room, so the card can say who is calling. */
  rooms: Room[];
  /** Who is in a call, per room, from the realtime stream. */
  presence: Record<string, CallParticipant[]>;
  /** Answering opens the conversation with its call, not just the chat. */
  onAnswer: (roomId: string) => void;
}) {
  const call = useActiveCall();
  const { joined } = call;
  const notifications = useSyncExternalStore(subscribeNotifications, notificationSnapshot);
  const [ringing, setRinging] = useState<Room | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  // Rooms whose current call has already been dealt with: declined, answered,
  // or rung out. Cleared when that call ends, so the next one rings again.
  const settled = useRef<Set<string>>(new Set());
  const busy = useRef<Set<string>>(new Set());

  useEffect(() => {
    const direct = rooms.filter((room) => isConversationRoom(room.kind));
    const visible = new Set(direct.map((room) => room.id));
    for (const id of busy.current) if (!visible.has(id)) busy.current.delete(id);
    for (const id of settled.current) if (!visible.has(id)) settled.current.delete(id);
    let started: Room | null = null;

    for (const room of direct) {
      const callers = presence[room.id] ?? [];
      const others = callers.filter((person) => person.user_id !== user?.id);
      if (others.length === 0) {
        // The call ended: this room is free to ring again next time.
        busy.current.delete(room.id);
        settled.current.delete(room.id);
        continue;
      }
      const wasBusy = busy.current.has(room.id);
      busy.current.add(room.id);
      if (!wasBusy && !settled.current.has(room.id)) {
        if (!notifications.ready || notifications.dnd || roomIsMuted(room.id, notifications)) settled.current.add(room.id);
        else started = room;
      }
    }

    // Your own call is never an incoming one, and neither is a room you left.
    if (joined || !user || !notifications.ready || notifications.dnd) {
      setRinging(null);
      return;
    }
    if (started) setRinging(started);
    else
      setRinging((current) =>
        current && busy.current.has(current.id) && !roomIsMuted(current.id, notifications) ? current : null,
      );
  }, [rooms, presence, joined, user?.id, notifications]);

  // The sound and the toast belong to the ring, so they start and stop with it.
  useEffect(() => {
    if (!ringing || notifications.dnd) {
      stopSound('ringtone');
      return;
    }
    loopSound('ringtone');
    const name = roomLabel(ringing);
    if (notifications.alerts && (document.hidden || !document.hasFocus()))
      void notifyDesktop({
        id: `call:${ringing.id}`,
        title: `${name} is calling`,
        body: 'Answer from BetterComms.',
        data: { roomId: ringing.id },
      });
    const timer = setTimeout(() => {
      settled.current.add(ringing.id);
      setRinging(null);
    }, GIVE_UP_AFTER);
    return () => {
      clearTimeout(timer);
      stopSound('ringtone');
      void clearDesktopNotification(`call:${ringing.id}`);
    };
  }, [ringing, notifications.dnd, notifications.alerts]);

  /*
    Answering is two steps: the call joins whichever room is open, so the room
    has to be the open one before the join can be asked for.
  */
  useEffect(() => {
    if (!answering) return;
    if (call.room?.id !== answering || call.busy) return;
    setAnswering(null);
    if (!call.joined) void call.join('replace');
  }, [answering, call.room?.id, call.busy, call.joined]);

  if (!ringing) return null;
  const name = roomLabel(ringing);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center [[data-desktop-frame]_&]:top-[52px]">
      <div className="pointer-events-auto flex animate-bc-rise items-center gap-3 rounded-full border border-border bc-glass py-2 pr-2 pl-2">
        <span className="relative grid size-11 shrink-0 place-items-center rounded-full bg-online/10 animate-bc-pulse">
          <Avatar name={name} id={ringing.id} />
          <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-online ring-2 ring-popover" />
        </span>
        <div className="min-w-0 pr-1">
          <strong className="block max-w-48 truncate text-sm font-semibold">
            {name}
          </strong>
          <span className="text-xs text-muted-foreground">
            Incoming call
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-9 rounded-full bg-dnd/12 px-3.5 text-destructive hover:bg-dnd/22 hover:text-destructive dark:hover:bg-dnd/22"
          onClick={() => {
            settled.current.add(ringing.id);
            setRinging(null);
          }}
        >
          <PhoneOff size={15} /> Decline
        </Button>
        <Button
          size="sm"
          className="h-9 rounded-full px-4 bc-glow"
          onClick={() => {
            settled.current.add(ringing.id);
            setRinging(null);
            onAnswer(ringing.id);
            setAnswering(ringing.id);
          }}
        >
          <Phone size={15} /> Answer
        </Button>
      </div>
    </div>
  );
}
