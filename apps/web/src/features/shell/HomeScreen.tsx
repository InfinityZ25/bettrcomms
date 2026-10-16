import { ArrowRight, Clapperboard, Headphones, Inbox, Plus, UserPlus } from 'lucide-react';
import { Avatar, leadingInitials } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import type { CallParticipant, Room, User } from '@/api';
import { cn } from '@/lib/utils';
import { Mascot } from '@/components/mascot';

/**
 * What you see with nothing open.
 *
 * This used to be a product headline over a card explaining that no room was
 * selected — true, and a poor thing to greet someone with. A place people come
 * back to several times a day should say hello, show whether anyone is around,
 * and put the next thing one click away.
 */
export default function HomeScreen({
  user,
  rooms,
  presence,
  presenceKnown,
  onSelectRoom,
  onCreateRoom,
  onFriends,
  onRecordings,
  onActivity,
}: {
  user: User | null;
  rooms: Room[];
  presence: Record<string, CallParticipant[]>;
  presenceKnown: boolean;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: () => void;
  onFriends: () => void;
  onRecordings: () => void;
  onActivity: () => void;
}) {
  const live = rooms
    .map((room) => ({ room, callers: presence[room.id] ?? [] }))
    .filter((entry) => entry.callers.length > 0);

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 bg-[radial-gradient(42rem_26rem_at_50%_28%,color-mix(in_oklch,var(--violet)_11%,transparent),transparent_70%)] px-1 py-6 animate-bc-rise min-[481px]:gap-7">
      <Mascot className="w-24 animate-bc-float drop-shadow-[0_18px_34px_color-mix(in_oklch,var(--violet)_42%,transparent)]" />
      <header className="flex flex-col items-center">
        <p className="max-w-[36rem] text-center font-heading text-3xl leading-[1.08] font-extrabold tracking-tight text-balance bc-gradient-text sm:text-4xl">
          {user ? greeting() : 'Hi!'} {user ? `${firstName(user.name)}, your people are here.` : 'A little closer, wherever.'}
        </p>
      </header>

      {user && (
        <section
          aria-labelledby="home-live"
          className="flex w-full max-w-xl flex-col items-center"
        >
          <h2
            id="home-live"
            className="flex items-center justify-center gap-2 text-center bc-kicker"
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 rounded-full',
                presenceKnown && live.length
                  ? 'bg-online animate-bc-pulse'
                  : 'bg-muted-foreground/60',
              )}
            />
            HAPPENING NOW
          </h2>
          <div className="mt-3 w-full text-center">
            {!presenceKnown ? (
              <p className="text-xs text-muted-foreground" role="status">
                Looking for your people…
              </p>
            ) : live.length ? (
              <ul className="grid gap-2.5 text-left sm:grid-cols-2 sm:[&>li:only-child]:col-span-2 sm:[&>li:only-child]:mx-auto sm:[&>li:only-child]:w-[calc(50%-0.3125rem)]">
                {live.map(({ room, callers }) => (
                  <li key={room.id}>
                    <LiveRoom
                      room={room}
                      callers={callers}
                      onSelect={() => onSelectRoom(room)}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                Quiet right now. Open a room and the others will see you there.
              </p>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="home-actions" className="w-full max-w-xl">
        <ul className="grid gap-2.5 sm:grid-cols-2">
          <li><Action icon={<Inbox size={18} />} tone="bg-primary/15 text-primary" title="Activity" note="Mentions, replies and requests." onClick={onActivity} disabled={!user} /></li>
          <li>
            <Action
              icon={<Plus size={18} />}
              tone="bg-violet/15 text-violet"
              title="New room"
              note="A place to call in."
              onClick={onCreateRoom}
              disabled={!user}
            />
          </li>
          <li>
            <Action
              icon={<UserPlus size={18} />}
              tone="bg-cyan/15 text-cyan"
              title="Find friends"
              note="Share your ID, add theirs."
              onClick={onFriends}
              disabled={!user}
            />
          </li>
          <li>
            <Action
              icon={<Clapperboard size={18} />}
              tone="bg-amber/15 text-amber"
              title="Recordings"
              note="Watch and export calls."
              onClick={onRecordings}
              disabled={!user}
            />
          </li>
        </ul>
      </section>
    </div>
  );
}

/** A room with people in it right now, and a way straight in. */
function LiveRoom({
  room,
  callers,
  onSelect,
}: {
  room: Room;
  callers: CallParticipant[];
  onSelect: () => void;
}) {
  const label = roomLabel(room);
  const shown = callers.slice(0, 4);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${label}, ${callers.length} in call`}
      className="group w-full cursor-pointer rounded-2xl border border-online/25 bg-card/85 p-3.5 text-left shadow-[var(--highlight)] transition-[transform,background-color,border-color,box-shadow] duration-150 ease-out hover:-translate-y-0.5 hover:border-online/50 hover:bg-accent/50 hover:shadow-[0_14px_34px_-16px_color-mix(in_oklch,var(--online)_60%,transparent)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.99]"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary after:absolute after:-top-0.5 after:-right-0.5 after:size-2.5 after:rounded-full after:bg-online after:ring-2 after:ring-card after:animate-bc-pulse">
          <Headphones size={16} />
        </span>
        <strong className="min-w-0 flex-1 truncate font-heading text-[0.9375rem] font-semibold">{label}</strong>
        <ArrowRight
          size={15}
          className="shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
        />
      </div>
      <div className="mt-3 flex min-w-0 items-center gap-2.5">
        <span className="flex -space-x-1.5" aria-hidden="true">
          {shown.map((person) => (
            <Avatar
              key={person.user_id}
              name={person.name || 'Friend'}
              id={person.user_id}
              className="size-6 rounded-full bg-card ring-2 ring-card"
            />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {describe(callers)}
        </span>
      </div>
    </button>
  );
}

function Action({
  icon,
  tone,
  title,
  note,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  /** The icon tile's colours: each action has its own, so the grid reads at a glance. */
  tone: string;
  title: string;
  note: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Button
      variant="secondary"
      className={cn(
        'group/action h-full w-full items-center justify-start gap-3.5 rounded-2xl border-border bg-card/80 px-3.5 py-3 text-left whitespace-normal shadow-[var(--highlight)] transition-[transform,background-color,border-color,box-shadow] duration-150 ease-out hover:-translate-y-0.5 hover:border-foreground/15 hover:bg-accent/55 hover:shadow-[var(--shadow-soft),var(--highlight)] active:scale-[0.99]',
        disabled && 'pointer-events-none opacity-60',
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-xl transition-transform duration-150 ease-out group-hover/action:scale-105 [&>svg]:size-5!',
          tone,
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-heading text-[0.9375rem] font-semibold">
          {title}
        </span>
        <span className="text-xs font-normal text-muted-foreground">{note}</span>
      </span>
      <ArrowRight
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out group-hover/action:translate-x-0.5 group-hover/action:text-foreground"
      />
    </Button>
  );
}

/** "Ada and Grace" rather than "2 in call": names are warmer than counts. */
function describe(callers: CallParticipant[]): string {
  const names = callers.map((person) => person.name || 'Friend');
  if (names.length === 1) return `${names[0]} is here`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more are here`;
}

const firstName = (name: string) => name.split(' ')[0] || name;

/** The greeting follows the clock, so the room feels like it knows the hour. */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export { describe as describeCallers, greeting, leadingInitials };
