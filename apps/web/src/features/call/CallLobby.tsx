import { Headphones, HeadphoneOff, MicOff, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/avatar';
import { Mascot } from '@/components/mascot';
import type { Room, User } from '@/api';
import type { CallPresence, JoinMode } from './callTypes';

/**
 * The room, before you walk in.
 *
 * It used to be two bordered panels side by side under a READY TO JOIN label,
 * with a paragraph explaining that your camera would stay off until you turned
 * it on. Nobody reads an instruction about a control they can see. What you
 * actually want to know standing at the door is whether anyone is in there, so
 * that is the whole screen now: the faces, or the mascot when the place is
 * empty, the room's name, and one way in.
 */
export default function CallLobby({
  user,
  room,
  busy,
  names,
  callPresence,
  presenceKnown,
  onJoin,
}: {
  user: User | null;
  room: Room | null;
  busy: boolean;
  names: Record<string, string>;
  callPresence: CallPresence[];
  presenceKnown: boolean;
  onJoin: (mode: JoinMode) => void;
}) {
  const others = callPresence.filter(
    (presence) => presence.user_id !== user?.id,
  );
  const alreadyIn = callPresence.find(
    (presence) => presence.user_id === user?.id,
  );
  const ready = Boolean(user && room);
  const label = (presence: CallPresence) =>
    presence.name || names[presence.user_id] || 'Friend';

  return (
    <section
      className="relative isolate mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-6 py-6 text-center before:pointer-events-none before:absolute before:inset-x-0 before:top-[6%] before:bottom-[24%] before:-z-10 before:rounded-full before:bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--violet)_15%,transparent),transparent)] before:content-[''] after:pointer-events-none after:absolute after:inset-x-[18%] after:bottom-[10%] after:-z-10 after:h-1/3 after:rounded-full after:bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--brand)_10%,transparent),transparent)] after:content-['']"
      aria-label="Call lobby"
    >
      {/* Who is in there is the answer to the only question worth asking here,
          so it is drawn first and largest. An empty room gets the mascot, which
          is friendlier than an empty box. */}
      {others.length > 0 ? (
        <ul
          className="flex flex-wrap justify-center gap-5"
          aria-label="In this call"
        >
          {others.map((presence) => (
            <li
              key={presence.user_id}
              className="flex w-24 animate-bc-pop flex-col items-center gap-2"
            >
              {/* They are in the call, so their presence is not a guess. */}
              <Avatar
                name={label(presence)}
                id={presence.user_id}
                presence="online"
                className="size-16 drop-shadow-[0_0_18px_color-mix(in_oklch,var(--online)_38%,transparent)]"
              />
              <span className="w-full truncate text-sm font-medium">
                {label(presence)}
              </span>
              <Signals presence={presence} />
            </li>
          ))}
        </ul>
      ) : (
        <Mascot className="w-32 animate-bc-float drop-shadow-[0_24px_34px_color-mix(in_oklch,var(--violet)_34%,transparent)]" />
      )}

      <div className="max-w-full">
        <h2
          className="font-heading text-3xl font-extrabold tracking-tight break-words bc-gradient-text sm:text-4xl"
          data-testid="room-heading"
        >
          {room ? room.display_name || room.name : 'Your call'}
        </h2>
        <p
          className="mt-3 text-[0.9375rem] leading-relaxed text-muted-foreground"
          role={ready && !presenceKnown ? 'status' : undefined}
        >
          {describe(others.map(label), ready, presenceKnown)}
        </p>
      </div>

      {alreadyIn && ready ? (
        <SecondDevice
          devices={alreadyIn.device_count}
          busy={busy}
          onJoin={onJoin}
        />
      ) : (
        <Button
          size="lg"
          className="h-12 gap-2 px-7 text-base font-semibold bc-glow hover:-translate-y-0.5 [&_svg:not([class*='size-'])]:size-5"
          disabled={busy || !ready}
          onClick={() => onJoin('replace')}
        >
          <Headphones size={18} />
          {busy ? 'Connecting…' : user ? 'Join call' : 'Sign in to join'}
        </Button>
      )}
    </section>
  );
}

/** Muted or deafened, and only when there is something to say. */
function Signals({ presence }: { presence: CallPresence }) {
  const notes = [
    presence.deafened && { icon: <HeadphoneOff size={11} className="size-3 text-dnd" />, text: 'Deafened' },
    !presence.deafened &&
      presence.muted && { icon: <MicOff size={11} className="size-3 text-dnd" />, text: 'Muted' },
    presence.device_count > 1 && {
      icon: null,
      text: `${presence.device_count} devices`,
    },
  ].filter(Boolean) as { icon: React.ReactNode; text: string }[];

  if (!notes.length) return null;
  return (
    <span className="flex flex-col items-center gap-0.5 text-[0.6875rem] text-muted-foreground">
      {notes.map((note) => (
        <span className="flex items-center gap-1" key={note.text}>
          {note.icon}
          {note.text}
        </span>
      ))}
    </span>
  );
}

/**
 * You are in this call from somewhere else.
 *
 * Rare, and worth spelling out: the two buttons do different things to the
 * other device, and picking the wrong one either drops a call you are on or
 * leaves two microphones in the same room feeding each other.
 */
export function SecondDevice({
  devices,
  busy,
  onJoin,
}: {
  devices: number;
  busy: boolean;
  onJoin: (mode: JoinMode) => void;
}) {
  return (
    <div className="w-full rounded-2xl bc-card p-4 text-left">
      <strong className="text-sm font-semibold" aria-live="polite">
        You are already in this call
        {devices > 1 ? ` on ${devices} devices` : ' on another device'}.
      </strong>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button className="bc-glow" disabled={busy} onClick={() => onJoin('replace')}>
          <Headphones size={18} /> {busy ? 'Connecting…' : 'Move it here'}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => onJoin('additional')}
        >
          <Plus size={18} /> Add this device
        </Button>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Adding this one keeps the other connected. Mute or deafen one of them if
        they are close enough to hear each other.
      </p>
    </div>
  );
}

/** "Ada and Grace are in here" — names, because a count is not a person. */
function describe(names: string[], ready: boolean, known: boolean): string {
  if (!ready) return 'Pick a room to see who is in it.';
  if (!known) return 'Seeing who is in…';
  if (!names.length)
    return 'Empty in here. Walk in and the others will see you.';
  if (names.length === 1) return `${names[0]} is in here.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are in here.`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more are in here.`;
}
