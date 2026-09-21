import { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import type { CallParticipant, Room, User } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { clearDesktopNotification, notifyDesktop } from '@/desktop/notifications';
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
  const [ringing, setRinging] = useState<Room | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  // Rooms whose current call has already been dealt with: declined, answered,
  // or rung out. Cleared when that call ends, so the next one rings again.
  const settled = useRef<Set<string>>(new Set());
  const busy = useRef<Set<string>>(new Set());

  useEffect(() => {
    const direct = rooms.filter((room) => (room.kind ?? 'channel') === 'direct');
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
      if (!wasBusy && !settled.current.has(room.id)) started = room;
    }

    // Your own call is never an incoming one, and neither is a room you left.
    if (joined || !user) {
      setRinging(null);
      return;
    }
    if (started) setRinging(started);
    else
      setRinging((current) =>
        current && busy.current.has(current.id) ? current : null,
      );
  }, [rooms, presence, joined, user?.id]);

  // The sound and the toast belong to the ring, so they start and stop with it.
  useEffect(() => {
    if (!ringing) {
      stopSound('ringtone');
      return;
    }
    loopSound('ringtone');
    const name = roomLabel(ringing);
    if (document.hidden || !document.hasFocus())
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
  }, [ringing?.id]);

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
      <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-border bg-card/95 py-2 pr-2 pl-3 shadow-[0_18px_46px_rgb(0_0_0/0.35)] backdrop-blur">
        <span className="relative">
          <Avatar name={name} id={ringing.id} />
          <span className="absolute -right-0.5 -bottom-0.5 size-2.5 animate-pulse rounded-full bg-primary ring-2 ring-card" />
        </span>
        <div className="min-w-0">
          <strong className="block max-w-48 truncate text-sm font-semibold">
            {name}
          </strong>
          <span className="text-[0.65rem] text-muted-foreground">
            Incoming call
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() => {
            settled.current.add(ringing.id);
            setRinging(null);
          }}
        >
          <PhoneOff size={15} /> Decline
        </Button>
        <Button
          size="sm"
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
