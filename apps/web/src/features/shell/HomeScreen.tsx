import { ArrowRight, Clapperboard, Headphones, Plus, UserPlus } from 'lucide-react';
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
}: {
  user: User | null;
  rooms: Room[];
  presence: Record<string, CallParticipant[]>;
  presenceKnown: boolean;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: () => void;
  onFriends: () => void;
  onRecordings: () => void;
}) {
  const live = rooms
    .map((room) => ({ room, callers: presence[room.id] ?? [] }))
    .filter((entry) => entry.callers.length > 0);

  return (
    <div className="flex items-center flex-col justify-center h-full gap-3">
      <Mascot />
      <header>
        <p className="text-center text-xl font-heading">
          {user ? greeting() : 'Hi!'} {user ? `${firstName(user.name)}, your people are here.` : 'A little closer, wherever.'}
        </p>
      </header>

      {user && (
        <section aria-labelledby="home-live">
          <h2
            id="home-live"
            className="text-[0.6rem] font-semibold tracking-[0.18em] text-muted-foreground text-center"
          >
            HAPPENING NOW
          </h2>
          <div className="mt-3">
            {!presenceKnown ? (
              <p className="text-xs text-muted-foreground" role="status">
                Looking for your people…
              </p>
            ) : live.length ? (
              <ul className="grid gap-2 sm:grid-cols-2">
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
              <p className="text-xs leading-6 text-muted-foreground">
                Quiet right now. Open a room and the others will see you there.
              </p>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="home-actions">
        <ul className="mt-3 grid gap-2 sm:grid-cols-3">
          <li>
            <Action
              icon={<Plus size={18} />}
              title="New room"
              note="A place to call in."
              onClick={onCreateRoom}
              disabled={!user}
            />
          </li>
          <li>
            <Action
              icon={<UserPlus size={18} />}
              title="Find friends"
              note="Share your ID, add theirs."
              onClick={onFriends}
              disabled={!user}
            />
          </li>
          <li>
            <Action
              icon={<Clapperboard size={18} />}
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
      className="w-full cursor-pointer rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
          <Headphones size={16} />
        </span>
        <strong className="min-w-0 flex-1 truncate text-sm">{label}</strong>
        <ArrowRight size={15} className="shrink-0 text-muted-foreground" />
      </div>
      <div className="mt-3 flex min-w-0 items-center gap-2">
        <span className="flex -space-x-2" aria-hidden="true">
          {shown.map((person) => (
            <Avatar
              key={person.user_id}
              name={person.name || 'Friend'}
              id={person.user_id}
              className="size-6"
            />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.7rem] text-muted-foreground">
          {describe(callers)}
        </span>
      </div>
    </button>
  );
}

function Action({
  icon,
  title,
  note,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  note: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Button
      variant="secondary"
      className={cn(
        'h-auto w-full flex-col items-start gap-1 rounded-2xl px-4 py-3.5 text-left whitespace-normal',
        disabled && 'pointer-events-none opacity-60',
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        {icon} {title}
      </span>
      <span className="text-[0.7rem] font-normal text-muted-foreground">{note}</span>
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
