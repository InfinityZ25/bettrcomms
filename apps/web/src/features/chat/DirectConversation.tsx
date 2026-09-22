import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Phone, Send } from 'lucide-react';
import { api, type Message, type Room, type User } from '@/api';
import { Avatar } from '@/components/avatar';
import { Mascot } from '@/components/mascot';
import { Button } from '@/components/ui/button';
import { GroupChat, type ChatMessage } from '@/components/ui/group-chat';
import { Input } from '@/components/ui/input';
import { useActiveCall } from '@/features/call/CallSessionContext';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import { hueFor } from '@/features/settings/blobatarIdentity';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';

const clock = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const dayOf = (value: string) => new Date(value).toDateString();

const dayLabel = (value: string) => {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? 'Today'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** One person speaking once or several times in a row, on one day. */
type Run = { key: string; seed: string; messages: ChatMessage[] };
type Day = { key: string; label: string; runs: Run[] };

/**
 * A conversation with one person.
 *
 * Opening a direct message used to land you in that room's call lobby, which
 * offered to start a call and no way to say anything — the panel that held the
 * messages was a drawer bolted to the side of a room, and it left when the
 * room chrome did. The conversation is the content here, and during a call it
 * moves to a column beside it rather than being replaced by it.
 */
export default function DirectConversation({
  room,
  user,
  live,
  variant = 'screen',
  docked = false,
  onCall,
  onError,
}: {
  room: Room;
  user: User | null;
  /** Messages the realtime stream has delivered since this screen loaded. */
  live: { sequence: number; value: Message }[];
  /** `panel` sits inside another surface, so it draws no frame of its own. */
  variant?: 'screen' | 'panel';
  /** A call is running and its dock is sitting in the bottom-left corner. */
  docked?: boolean;
  /** Open the call for this conversation. */
  onCall: () => void;
  onError: (message: string) => void;
}) {
  const call = useActiveCall();
  const [history, setHistory] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setHistory([]);
    void api<{ messages: Message[] }>(`/rooms/${room.id}/messages`)
      .then((result) => {
        if (current) setHistory(result.messages ?? []);
      })
      .catch((error) => {
        if (current) onError(errorMessage(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [room.id]);

  /*
    The socket and the fetch overlap, and posting a message returns the same
    message the socket is about to deliver, so both are merged by id and sorted
    by time rather than trusted to arrive once and in order.
  */
  const messages = useMemo(() => {
    const byId = new Map<string, Message>();
    for (const message of history) byId.set(message.id, message);
    for (const { value } of live)
      if (value.room_id === room.id) byId.set(value.id, value);
    return [...byId.values()].sort(
      (left, right) =>
        Date.parse(left.created_at) - Date.parse(right.created_at),
    );
  }, [history, live, room.id]);

  /*
    Days, then runs of one speaker inside each day.

    The runs are handed to GroupChat one at a time rather than as a whole
    thread, which is the one thing that component cannot do for us: the options
    it draws faces with belong to the room, and a face's colour here belongs to
    the person — the same colour their avatar has everywhere else in the app.
  */
  const days = useMemo(() => {
    const out: Day[] = [];
    for (const message of messages) {
      const key = dayOf(message.created_at);
      let day = out.at(-1);
      if (!day || day.key !== key) {
        day = { key, label: dayLabel(message.created_at), runs: [] };
        out.push(day);
      }
      const seed = message.author.id;
      const entry: ChatMessage = {
        name: seed,
        title: message.author.id === user?.id ? 'You' : message.author.name,
        text: message.body,
        time: clock(message.created_at),
      };
      const run = day.runs.at(-1);
      if (run && run.seed === seed) run.messages.push(entry);
      else day.runs.push({ key: message.id, seed, messages: [entry] });
    }
    return out;
  }, [messages, user?.id]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const result = await api<{ message: Message }>(
        `/rooms/${room.id}/messages`,
        { body },
      );
      setDraft('');
      if (result.message) setHistory((current) => [...current, result.message]);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  const name = roomLabel(room);
  const inThisCall = call.joined && call.callRoom?.id === room.id;

  return (
    <section
      className={cn(
        'flex min-w-0 flex-1 flex-col overflow-hidden bg-background',
        variant === 'screen'
          ? 'content-canvas rounded-3xl border border-border/60 shadow-[0_20px_60px_rgb(0_0_0/0.16)]'
          : 'rounded-2xl border border-border/60',
      )}
      aria-label={`Conversation with ${name}`}
    >
      <header className="flex items-center gap-2.5 px-4 py-2.5">
        <Avatar name={name} id={peerId(room, user, messages)} />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm font-semibold">{name}</strong>
          <span className="text-[0.65rem] text-muted-foreground">
            {inThisCall ? 'In a call with you' : 'Direct message'}
          </span>
        </div>
        {/* The one place the conversation reaches for the call: pressing this
            starts it, rather than opening a lobby to press again. */}
        {!inThisCall && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={!user || call.busy}
            onClick={() => {
              void call.join('replace');
              onCall();
            }}
          >
            <Phone size={15} /> Call
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {loading ? (
          <p className="p-2 text-xs text-muted-foreground" role="status">
            Opening the conversation…
          </p>
        ) : !messages.length ? (
          <div className="grid h-full place-content-center justify-items-center gap-2 p-4 text-center">
            <Mascot className="w-16" />
            <strong className="font-heading text-base font-semibold">
              Say something to {name}.
            </strong>
            <p className="max-w-72 text-xs leading-6 text-muted-foreground">
              A link, a thought, a very important meme. Calls in here land in the
              same place.
            </p>
          </div>
        ) : (
          days.map((day) => (
            <div key={day.key}>
              <div className="my-3 flex items-center gap-3 text-[0.6rem] tracking-wider text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
                {day.label}
              </div>
              {day.runs.map((run) => (
                <GroupChat
                  key={run.key}
                  messages={run.messages}
                  blobatar={{ hue: hueFor(run.seed) }}
                  className="rounded-none border-0 bg-transparent [&>div]:gap-2 [&>div]:px-1 [&>div]:py-1.5"
                />
              ))}
            </div>
          ))
        )}
        <div ref={end} />
      </div>

      <form
        className={cn(
          'm-3 flex items-center gap-1 rounded-2xl border bg-muted/60 pr-2 focus-within:ring-2 focus-within:ring-ring/40',
          // Room for the call dock, which floats in this corner.
          docked && 'mb-[68px]',
        )}
        onSubmit={send}
      >
        <Input
          className="min-w-0 border-0 bg-transparent px-4 py-3 text-sm shadow-none focus-visible:ring-0"
          placeholder={user ? `Message ${name}…` : 'Sign in to say hello'}
          aria-label={`Message ${name}`}
          value={draft}
          maxLength={4000}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!user}
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          className="size-9 shrink-0 text-primary"
          aria-label="Send message"
          disabled={!draft.trim() || sending}
        >
          <Send size={17} />
        </Button>
      </form>
    </section>
  );
}

/**
 * The other person's account, for their face in the header.
 *
 * A direct room carries their display name but not their id, so it comes from
 * whoever in the conversation is not you. Before anybody has said anything
 * there is nobody to read it from, and the name seeds the face instead.
 */
function peerId(room: Room, user: User | null, messages: Message[]) {
  const other = messages.find((message) => message.author.id !== user?.id);
  return other?.author.id ?? roomLabel(room);
}
