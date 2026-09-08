import {
  Hash,
  Headphones,
  HeadphoneOff,
  MessageSquare,
  MicOff,
  Plus,
} from 'lucide-react';
import type { CallParticipant, Room } from '@/api';
import { cn } from '@/lib/utils';

export const roomLabel = (room: Room) => room.display_name || room.name;

export default function RoomNavigation({
  rooms,
  selected,
  presence,
  known,
  onSelect,
  onCreate,
}: {
  rooms: Room[];
  selected?: string;
  presence: Record<string, CallParticipant[]>;
  known: boolean;
  onSelect: (room: Room) => void;
  onCreate: () => void;
}) {
  return (
    <div className="min-h-0 overflow-x-hidden overflow-y-auto">
      {(['channel', 'direct'] as const).map((kind) => {
        const entries = rooms.filter(
          (room) => (room.kind ?? 'channel') === kind,
        );
        if (kind === 'direct' && !entries.length) return null;
        return (
          <section
            key={kind}
            aria-label={kind === 'direct' ? 'Direct messages' : 'Rooms'}
          >
            <div className="mx-2 mt-7 mb-3 flex items-center justify-between text-[0.7rem] font-bold tracking-[0.12em] text-muted-foreground">
              {kind === 'direct' ? 'DIRECT MESSAGES' : 'ROOMS'}
              {kind === 'channel' && (
                <button
                  className="rounded p-0.5 transition-colors hover:bg-accent hover:text-accent-foreground"
                  aria-label="Create room"
                  onClick={onCreate}
                >
                  <Plus size={16} />
                </button>
              )}
            </div>
            {!entries.length && (
              <p className="px-2 py-1 text-xs leading-6 text-muted-foreground">
                Create a room to bring your friends together.
              </p>
            )}
            {entries.map((room) => {
              const callers = presence[room.id] ?? [];
              return (
                <div key={room.id}>
                  <button
                    className={cn(
                      'mb-0.5 flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&>svg]:shrink-0',
                      selected === room.id &&
                        'bg-accent text-accent-foreground',
                    )}
                    aria-current={selected === room.id ? 'page' : undefined}
                    onClick={() => onSelect(room)}
                    title={roomLabel(room)}
                  >
                    {kind === 'direct' ? (
                      <MessageSquare size={18} />
                    ) : (
                      <Hash size={19} />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {roomLabel(room)}
                    </span>
                    {known && callers.length > 0 && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 text-xs text-primary"
                        aria-label={`${callers.length} in call`}
                      >
                        <Headphones size={12} />
                        {callers.length}
                      </span>
                    )}
                  </button>
                  {known && callers.length > 0 && (
                    <ul
                      className="mt-1 mb-3 ml-5 list-none border-l pl-3"
                      aria-label={`${roomLabel(room)} call participants`}
                    >
                      {callers.map((person) => (
                        <li
                          className="flex min-w-0 items-center gap-2 py-1 pr-1 text-xs text-foreground/75 [&>svg]:shrink-0"
                          key={person.user_id}
                        >
                          <span
                            className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[0.65rem] text-muted-foreground"
                            aria-hidden="true"
                          >
                            {(person.name || '?').slice(0, 1).toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {person.name || 'Participant'}
                            {person.device_count > 1
                              ? ` · ${person.device_count} devices`
                              : ''}
                          </span>
                          {person.deafened ? (
                            <HeadphoneOff size={14} aria-label="Deafened" />
                          ) : person.muted ? (
                            <MicOff size={14} aria-label="Muted" />
                          ) : (
                            <span
                              className="mr-1 size-1.5 rounded-full bg-primary"
                              aria-label="In call"
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
      {!known && rooms.length > 0 && (
        <p className="mx-2 my-3 text-xs text-muted-foreground">
          Call activity unavailable
        </p>
      )}
    </div>
  );
}
