import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AudioLines,
  Clapperboard,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  Hash,
  Headphones,
  LayoutPanelTop,
  LogOut,
  Maximize2,
  MessageSquare,
  Mic,
  MonitorUp,
  MoreHorizontal,
  Plus,
  Radio,
  Send,
  Settings2,
  ShieldCheck,
  SunMoon,
  Users,
  Video,
  Volume2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from './components/ui/button';
import { Dialog } from './components/ui/dialog';
import { ModeToggle } from './components/mode-toggle';
import {
  api,
  type User,
  type Room,
  type Message,
  type CallParticipant,
} from './api';
import CallStage, { type NativeShareActions } from '@/features/call/CallStage';
import { useCallPresence } from '@/features/call/useCallPresence';
import FriendsPanel from '@/features/friends/FriendsPanel';
import RecordingsLibrary from '@/features/recordings/RecordingsLibrary';
import RoomNavigation, { roomLabel } from '@/features/rooms/RoomNavigation';
import RoomSettings from '@/features/rooms/RoomSettings';
import MediaSettings from '@/features/settings/MediaSettings';
import NativeScreenPicker from '@/features/sharing/NativeScreenPicker';
import WorkspaceScreen from '@/features/shell/WorkspaceScreen';
import { cn } from '@/lib/utils';

type Screen = 'call' | 'settings' | 'recordings' | 'share';
const emptyCall: CallParticipant[] = [];
const mergeMessages = (...groups: Message[][]) => {
  const byId = new Map<string, Message>();
  for (const group of groups) for (const message of group) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
  );
};
const readScreen = (): Screen =>
  location.hash === '#/settings'
    ? 'settings'
    : location.hash === '#/recordings'
      ? 'recordings'
      : location.hash === '#/share'
        ? 'share'
        : 'call';

const initials = (name: string) =>
  name
    .split(' ')
    .map((x) => x[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted text-xs font-semibold text-muted-foreground',
        large && 'size-14 rounded-full text-xl',
      )}
    >
      {initials(name)}
    </span>
  );
}
export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [devAuth, setDevAuth] = useState(false),
    [error, setError] = useState('');
  const [rooms, setRooms] = useState<Room[]>([]),
    [room, setRoom] = useState<Room | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [draft, setDraft] = useState('');
  const presence = useCallPresence(user?.id);
  const [create, setCreate] = useState(false),
    [friends, setFriends] = useState(false),
    [chat, setChat] = useState(window.innerWidth > 820),
    [roomName, setRoomName] = useState(''),
    [name, setName] = useState(''),
    [email, setEmail] = useState('');
  const [roomSettings, setRoomSettings] = useState(false),
    [callJoined, setCallJoined] = useState(false),
    [callRoom, setCallRoom] = useState<Room | null>(null),
    [callFocused, setCallFocused] = useState(false),
    [layout, setLayout] = useState(
      localStorage.getItem('bc-layout') === 'focus'
        ? 'top'
        : (localStorage.getItem('bc-layout') ?? 'top'),
    ),
    [copied, setCopied] = useState(false),
    [busy, setBusy] = useState(false);
  const [noise, setNoise] = useState(
      localStorage.getItem('bc-noise') !== 'off',
    ),
    [balanced, setBalanced] = useState(
      localStorage.getItem('bc-balance') === 'true',
    );
  const [screen, setScreen] = useState<Screen>(readScreen);
  const [shareActions, setShareActions] = useState<NativeShareActions | null>(
    null,
  );
  const shareActionsRef = useRef<NativeShareActions | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const navigate = (next: Screen) => {
    if (screen === 'call' && next !== 'call')
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    location.hash = next === 'call' ? '#/' : '#/' + next;
  };
  const setSettings = (open: boolean) => navigate(open ? 'settings' : 'call');
  const setRecordingsOpen = (open: boolean) =>
    navigate(open ? 'recordings' : 'call');
  useEffect(() => {
    const changed = () => {
      const next = readScreen();
      if (screen === 'share' && next !== 'share' && shareActionsRef.current) {
        shareActionsRef.current.onClose();
        shareActionsRef.current = null;
        setShareActions(null);
      }
      setScreen(next);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [screen]);
  useEffect(() => {
    if (screen === 'share' && !shareActionsRef.current) navigate('call');
  }, [screen]);
  useEffect(() => {
    if (screen === 'share') navigate('call');
  }, [room?.id, user?.id]);
  useEffect(() => {
    if (screen === 'call') returnFocus.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.fullscreenElement &&
        screen !== 'call' &&
        !document.querySelector('[role="dialog"]')
      )
        navigate('call');
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [screen]);
  useEffect(() => {
    const failed = (event: Event) =>
      setError((event as CustomEvent<string>).detail);
    window.addEventListener('bc-output-error', failed);
    return () => window.removeEventListener('bc-output-error', failed);
  }, []);
  useEffect(() => {
    if (callJoined) setChat(false);
  }, [callJoined]);
  useEffect(() => {
    const restore = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !document.fullscreenElement &&
        !document.querySelector('[role="dialog"]')
      )
        setCallFocused(false);
    };
    window.addEventListener('keydown', restore);
    return () => window.removeEventListener('keydown', restore);
  }, []);
  const messagesEnd = useRef<HTMLDivElement>(null);
  async function loadRooms() {
    const result = await api<{ rooms: Room[] }>('/rooms');
    setRooms(result.rooms ?? []);
    setRoom(
      (current) =>
        result.rooms?.find((r) => r.id === current?.id) ??
        result.rooms?.[0] ??
        null,
    );
  }
  useEffect(() => {
    api<{ dev_auth: boolean }>('/config')
      .then((c) => setDevAuth(c.dev_auth))
      .catch(() => {});
    api<User | { user: User }>('/me')
      .then((r) => {
        setUser('user' in r ? r.user : r);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    loadRooms().catch((e) => setError(e.message));
  }, [user?.id, presence.roomsRevision, presence.syncRevision]);
  useEffect(() => {
    setMessages([]);
    if (!room) return;
    let active = true;
    const refresh = () =>
      api<{ messages: Message[] }>('/rooms/' + room.id + '/messages')
        .then((r) => {
          if (active) setMessages((current) => mergeMessages(r.messages ?? [], current));
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    refresh();
    return () => {
      active = false;
    };
  }, [room?.id, presence.syncRevision]);
  useEffect(() => {
    const incoming = presence.messages
      .map((event) => event.value)
      .filter((message) => message.room_id === room?.id);
    if (!incoming.length) return;
    setMessages((current) => mergeMessages(current, incoming));
  }, [presence.messages, room?.id]);
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);
  useEffect(() => {
    localStorage.setItem('bc-layout', layout);
    localStorage.setItem('bc-noise', noise ? 'on' : 'off');
    localStorage.setItem('bc-balance', String(balanced));
  }, [layout, noise, balanced]);
  async function run(task: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !room) return;
    await run(async () => {
      const result = await api<{ message: Message }>('/rooms/' + room.id + '/messages', { body: draft });
      setDraft('');
      setMessages((current) => mergeMessages(current, [result.message]));
    });
  }
  const login = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      const r = await api<User | { user: User }>('/auth/dev', { email, name });
      setUser('user' in r ? r.user : r);
    });
  };
  if (loading)
    return (
      <div className="flex h-dvh items-center justify-center gap-4 text-primary">
        <AudioLines size={36} />
        <span>Opening your space…</span>
      </div>
    );
  return (
    <div
      data-app-shell
      data-in-call={callJoined}
      data-call-focused={callJoined && callFocused && screen === 'call'}
      className="flex h-dvh min-h-[600px] overflow-hidden min-[821px]:min-h-[680px]"
    >
      <nav
        className={cn(
          'flex w-[52px] shrink-0 flex-col items-center gap-3 border-r bg-sidebar px-1.5 py-5 max-[480px]:gap-2 min-[481px]:w-[62px] min-[481px]:px-2 min-[1001px]:w-[76px] min-[1001px]:px-3 min-[1001px]:pt-6 min-[1001px]:pb-4',
          callJoined && 'min-[821px]:w-[52px] min-[821px]:px-1',
          callJoined && callFocused && screen === 'call' && 'hidden',
        )}
        aria-label="Spaces"
        inert={screen === 'share'}
      >
        <a
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground min-[481px]:size-11 min-[481px]:rounded-2xl [&_svg]:size-6 min-[481px]:[&_svg]:size-7"
          href="/"
          aria-label="Bettercomms home"
        >
          <AudioLines />
        </a>
        <div className="my-1 h-px w-6 bg-border" />
        <button
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent font-bold text-accent-foreground transition-colors hover:bg-accent/80 min-[481px]:size-11 min-[481px]:rounded-2xl"
          onClick={() => setFriends(true)}
          aria-label="Friends"
        >
          <Users size={22} />
        </button>
        {rooms.slice(0, 5).map((r) => (
          <button
            key={r.id}
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-xl font-bold text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground min-[481px]:size-11 min-[481px]:rounded-2xl',
              room?.id === r.id && 'bg-accent text-accent-foreground',
            )}
            onClick={() => {
              setRoom(r);
              navigate('call');
            }}
            title={roomLabel(r)}
          >
            {initials(roomLabel(r))}
          </button>
        ))}
        <button
          className="grid size-9 shrink-0 place-items-center rounded-xl border border-dashed text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground min-[481px]:size-11 min-[481px]:rounded-2xl"
          aria-label="Create a space"
          onClick={() => setCreate(true)}
        >
          <Plus />
        </button>
        <button
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground min-[481px]:size-11 min-[481px]:rounded-2xl',
            screen === 'recordings' && 'bg-accent text-accent-foreground',
          )}
          aria-current={screen === 'recordings' ? 'page' : undefined}
          aria-label="Recordings"
          title="Recordings"
          onClick={() => setRecordingsOpen(true)}
        >
          <Clapperboard size={21} />
        </button>
        <div className="mt-auto flex flex-col items-center gap-4">
          <button
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground min-[481px]:size-11 min-[481px]:rounded-2xl',
              screen === 'settings' && 'bg-accent text-accent-foreground',
            )}
            aria-current={screen === 'settings' ? 'page' : undefined}
            aria-label="Audio and video settings"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={21} />
          </button>
          {user ? (
            <Avatar name={user.name} />
          ) : (
            <span className="size-1.5 rounded-full bg-primary" />
          )}
        </div>
      </nav>
      <aside
        className={cn(
          'hidden w-[170px] shrink-0 flex-col border-r bg-sidebar px-4 min-[821px]:flex min-[1251px]:w-[190px] min-[1400px]:w-[232px]',
          callJoined && 'min-[821px]:hidden',
          callJoined && callFocused && screen === 'call' && 'hidden',
        )}
        inert={screen === 'share'}
      >
        <div className="flex h-[70px] shrink-0 items-center justify-between px-2 font-heading text-base font-bold min-[1001px]:h-20">
          Your space <ChevronDown size={16} />
        </div>
        <button
          className="flex items-center gap-3 rounded-lg px-2.5 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onClick={() => setFriends(true)}
        >
          <Users size={18} /> Friends{' '}
          <span className="ml-auto opacity-60">↗</span>
        </button>
        <RoomNavigation
          rooms={rooms}
          selected={room?.id}
          presence={presence.rooms}
          known={presence.known}
          onSelect={(next) => {
            setRoom(next);
            navigate('call');
          }}
          onCreate={() => setCreate(true)}
        />
        <div className="mx-2 mt-auto mb-6 pt-6">
          <span className="mb-4 grid size-9 place-items-center rounded-xl bg-accent text-muted-foreground">
            <Headphones size={20} />
          </span>
          <strong className="font-heading text-sm leading-6 font-semibold text-foreground/75">
            Good company.
            <br />
            Room to be yourself.
          </strong>
          <p className="mt-2 max-w-40 text-xs leading-5 text-muted-foreground">
            Your calls, the way you like them.
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2.5 border-t py-5">
          <Avatar name={user?.name ?? 'You'} />
          <div className="min-w-0 flex-1 overflow-hidden">
            <strong className="block truncate text-xs">
              {user?.name ?? 'Welcome in'}
            </strong>
            <span className="mt-1 flex items-center gap-1 text-[0.65rem] text-muted-foreground">
              <i className="size-1.5 rounded-full bg-primary" />
              {user ? 'Available' : 'Make yourself at home'}
            </span>
          </div>
          <button
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-label="Settings"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={18} />
          </button>
        </div>
      </aside>
      <main
        className={cn(
          'min-w-0 flex-1 flex-col',
          screen === 'call' ? 'flex' : 'hidden',
        )}
        aria-label="Call"
        hidden={screen !== 'call'}
      >
        <header
          className={cn(
            'flex h-[70px] shrink-0 items-center justify-between gap-2.5 border-b px-3 min-[481px]:px-5 min-[1001px]:h-20 min-[1001px]:gap-5 min-[1001px]:px-7',
            callJoined && 'h-14 min-[1001px]:h-14',
            callJoined && callFocused && 'hidden',
          )}
        >
          <div className="flex min-w-0 items-center gap-2 min-[481px]:gap-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
            {room?.kind === 'direct' ? (
              <MessageSquare size={22} />
            ) : (
              <Hash size={22} />
            )}
            <strong className="max-w-[125px] truncate text-sm min-[481px]:max-w-[170px] min-[821px]:max-w-xs">
              {room ? roomLabel(room) : 'The living room'}
            </strong>
            <span className="hidden h-5 w-px bg-border min-[821px]:block" />
            <span className="hidden text-xs text-muted-foreground min-[1251px]:inline">
              {room?.kind === 'direct'
                ? 'Direct conversation'
                : 'A place to hang out'}
            </span>
          </div>
          <div className="flex items-center gap-1 min-[481px]:gap-3">
            {callJoined && callRoom && room?.id !== callRoom.id && (
              <Button
                variant="secondary"
                className="max-w-48 truncate"
                onClick={() => setRoom(callRoom)}
              >
                <Headphones size={15} /> Return to {roomLabel(callRoom)}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Room settings"
              disabled={!room}
              onClick={() => setRoomSettings(true)}
            >
              <Settings2 size={18} />
            </Button>
            <span className="hidden items-center gap-2 text-xs text-muted-foreground min-[1251px]:flex">
              <ShieldCheck size={15} /> Private room
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setFriends(true)}
              aria-label="Invite friends"
            >
              <Users size={19} />
            </Button>
            <Button
              variant={chat ? 'secondary' : 'ghost'}
              size="icon"
              onClick={() => setChat(!chat)}
              aria-label="Toggle chat"
            >
              <MessageSquare size={18} />
            </Button>
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1">
          <section
            className={cn(
              'flex min-w-0 flex-1 flex-col overflow-auto px-3 pt-5 pb-3 [scroll-padding-bottom:1.5rem] min-[481px]:px-5 min-[821px]:pb-0 min-[1251px]:px-8',
              callJoined ? 'pt-5' : 'min-[821px]:pt-8',
              callFocused &&
                screen === 'call' &&
                'p-0 min-[481px]:p-0 min-[821px]:p-0 min-[1251px]:p-0',
            )}
          >
            {!user && (
              <div className="mb-5 flex items-center justify-between min-[481px]:mb-7">
                <div>
                  <span className="text-[0.6rem] font-semibold tracking-[0.18em] text-muted-foreground">
                    MAKE ROOM FOR YOUR PEOPLE
                  </span>
                  <h1 className="mt-3 font-heading text-2xl font-semibold tracking-tight min-[481px]:text-[clamp(1.5rem,2.1vw,2.125rem)]">
                    {user ? 'Better together.' : 'A little closer, wherever.'}
                  </h1>
                  <p className="mt-3 max-w-96 text-xs leading-6 text-muted-foreground min-[481px]:text-sm">
                    {user
                      ? 'Start a call. Share something good. Stay a while.'
                      : 'Clear conversations. Beautiful streams. A space that feels like yours.'}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Layout settings"
                  onClick={() => setLayout(layout === 'top' ? 'focus' : 'top')}
                >
                  <LayoutPanelTop size={20} />
                </Button>
              </div>
            )}
            <CallStage
              user={user}
              room={callJoined ? callRoom : room}
              layout={layout}
              onLayout={setLayout}
              onJoinedChange={(joined) => {
                setCallJoined(joined);
                if (joined) setCallRoom(current => current ?? room);
                else setCallRoom(null);
              }}
              focused={callFocused}
              onFocus={() => setCallFocused((value) => !value)}
              noise={noise}
              balanced={balanced}
              callPresence={
                (callJoined ? callRoom : room)
                  ? (presence.rooms[(callJoined ? callRoom : room)!.id] ??
                    emptyCall)
                  : emptyCall
              }
              presenceKnown={presence.known}
              onError={setError}
              onInvite={() => setFriends(true)}
              onRecordings={() => setRecordingsOpen(true)}
              onRequestShare={(actions) => {
                if (document.fullscreenElement) void document.exitFullscreen();
                shareActionsRef.current = actions;
                setShareActions(actions);
                navigate('share');
              }}
            />
            {!user && (
              <div
                id="signin"
                className="flex shrink-0 flex-col items-stretch justify-between gap-4 border-t py-5 min-[821px]:flex-row min-[821px]:flex-wrap min-[821px]:items-center min-[821px]:pb-6"
              >
                <div>
                  <strong className="text-sm">
                    Your people are one sign-in away.
                  </strong>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Sign in securely to create rooms and invite your friends.
                  </p>
                </div>
                <Button onClick={() => location.assign('/api/v1/auth/login')}>
                  Continue with WorkOS <ArrowRight size={17} />
                </Button>
                {devAuth && (
                  <form
                    className="grid w-full grid-cols-1 items-center gap-2.5 pb-2.5 min-[821px]:flex min-[821px]:flex-wrap"
                    onSubmit={login}
                  >
                    <span className="my-1 text-[0.65rem] text-muted-foreground min-[821px]:my-0 min-[821px]:shrink-0">
                      Local development
                    </span>
                    <input
                      className="min-w-20 min-[821px]:flex-1"
                      aria-label="Your name"
                      placeholder="Your name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                    <input
                      className="min-w-20 min-[821px]:flex-1"
                      aria-label="Your email"
                      type="email"
                      placeholder="you@example.test"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                    <Button variant="secondary" disabled={busy}>
                      Enter local workspace
                    </Button>
                  </form>
                )}
              </div>
            )}
          </section>
          {chat && (
            <aside
              className={cn(
                'absolute top-[70px] right-0 bottom-0 z-10 flex w-[calc(100vw-52px)] shrink-0 flex-col border-l bg-card shadow-[-20px_0_50px_rgb(0_0_0/0.25)] min-[481px]:w-[300px] min-[821px]:static min-[821px]:w-[230px] min-[821px]:shadow-none min-[1251px]:w-[250px] min-[1400px]:w-[300px]',
                callJoined && callFocused && 'hidden',
              )}
            >
              <div className="flex items-center justify-between px-5 pt-6 pb-5">
                <strong className="text-sm font-semibold">Room chat</strong>
                <button
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={() => setChat(false)}
                  aria-label="Close chat"
                >
                  <X size={17} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-5">
                {!messages.length ? (
                  <div className="mt-4">
                    <span className="grid size-12 place-items-center rounded-xl border bg-muted text-muted-foreground">
                      <MessageSquare size={24} />
                    </span>
                    <h3 className="mt-5 max-w-44 font-heading text-base leading-6 font-semibold">
                      The conversation starts here.
                    </h3>
                    <p className="mt-2.5 text-xs leading-6 text-muted-foreground">
                      A link, a thought, a very important meme.
                      <br />
                      Drop it in.
                    </p>
                    <span className="my-8 flex items-center gap-2 text-[0.6rem] tracking-widest text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
                      TODAY
                    </span>
                  </div>
                ) : (
                  messages.map((m) => (
                    <div className="mb-5 flex gap-2.5" key={m.id}>
                      <Avatar name={m.author.name} />
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <strong className="text-xs">{m.author.name}</strong>
                          <time className="text-[0.6rem] text-muted-foreground">
                            {new Date(m.created_at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        </div>
                        <p className="mt-1 [overflow-wrap:anywhere] whitespace-pre-wrap text-sm leading-6 text-foreground/80">
                          {m.body}
                        </p>
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEnd} />
              </div>
              <form
                className="mx-4 mt-2.5 flex items-center rounded-xl border bg-muted pr-3 focus-within:ring-2 focus-within:ring-ring/40"
                onSubmit={send}
              >
                <input
                  className="min-w-0 border-0 bg-transparent px-3 py-3.5 text-xs shadow-none outline-none focus-visible:ring-0"
                  placeholder={
                    user ? 'Message your room…' : 'Sign in to say hello'
                  }
                  aria-label="Message your room"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={!user || !room}
                />
                <button
                  className="rounded-md p-1 text-primary transition-colors hover:bg-accent disabled:opacity-40"
                  aria-label="Send message"
                  disabled={!draft.trim() || busy}
                >
                  <Send size={17} />
                </button>
              </form>
              <span className="px-2 py-3 text-center text-[0.6rem] text-muted-foreground">
                A little less distance. A little more us.
              </span>
            </aside>
          )}
        </div>
      </main>
      {screen === 'recordings' && (
        <WorkspaceScreen
          title="Recordings"
          description="Your moments, with every voice in your control."
          onBack={() => navigate('call')}
        >
          <RecordingsLibrary />
        </WorkspaceScreen>
      )}
      {screen === 'share' && shareActions && (
        <NativeScreenPicker
          onShare={async (options) => {
            await shareActions.onShare(options);
            if (shareActionsRef.current !== shareActions) return;
            shareActionsRef.current = null;
            setShareActions(null);
            navigate('call');
          }}
          onBrowser={async () => {
            await shareActions.onBrowser();
            if (shareActionsRef.current !== shareActions) return;
            shareActionsRef.current = null;
            setShareActions(null);
            navigate('call');
          }}
          onClose={() => navigate('call')}
        />
      )}
      {error && (
        <div
          className="fixed bottom-6 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm text-card-foreground shadow-2xl"
          role="alert"
        >
          <CircleHelp size={18} />
          {error}
          <button
            className="ml-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={() => setError('')}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
      <RoomSettings
        room={room}
        user={user}
        open={roomSettings}
        onOpenChange={setRoomSettings}
        onChanged={() => loadRooms().catch((e) => setError(e.message))}
        onError={setError}
        refreshRevision={presence.roomsRevision + presence.syncRevision}
      />
      <Dialog
        open={create}
        onOpenChange={setCreate}
        title="Make a little room"
        description="A private place for your calls, screen shares, and conversations."
      >
        <form
          className="mt-6 flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await api<Room | { room: Room }>('/rooms', {
                name: roomName,
              });
              const created = 'room' in r ? r.room : r;
              await loadRooms();
              setRoom(created);
              setCreate(false);
              setRoomName('');
            });
          }}
        >
          <label className="block text-xs font-medium text-foreground/80">
            Room name
            <input
              className="mt-2"
              autoFocus
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Friday night crew"
              maxLength={80}
              required
            />
          </label>
          {!user && <p>Sign in before creating your first room.</p>}
          <Button disabled={!user || busy}>
            Create room <ArrowRight size={16} />
          </Button>
        </form>
      </Dialog>
      <Dialog
        open={friends}
        onOpenChange={setFriends}
        title="Better with friends"
        description="Share your user ID with a friend so they can send you a request."
      >
        <div className="mt-6 flex flex-col gap-5">
          {user ? (
            <>
              <label className="block text-xs font-medium text-foreground/80">
                Your user ID
                <div className="mt-2 flex items-center gap-2">
                  <input className="text-xs" readOnly value={user.id} />
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label="Copy user ID"
                    onClick={() => {
                      navigator.clipboard.writeText(user.id);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                  </Button>
                </div>
              </label>
              <FriendsPanel
                callPresence={presence.rooms}
                onlineUsers={presence.onlineUsers}
                refreshRevision={presence.friendsRevision + presence.syncRevision}
                user={user}
                room={room}
                onError={setError}
                onOpenRoom={(r) => {
                  setRoom(r);
                  setRooms((list) =>
                    list.some((x) => x.id === r.id) ? list : [r, ...list],
                  );
                  setFriends(false);
                }}
              />
            </>
          ) : (
            <Button onClick={() => location.assign('/api/v1/auth/login')}>
              Sign in to find your people
            </Button>
          )}
        </div>
      </Dialog>
      {screen === 'settings' && (
        <WorkspaceScreen
          title="Settings"
          description="Make it sound like you. Your preferences stay on this device."
          onBack={() => navigate('call')}
        >
          <div className="mt-6 max-w-[920px]">
            <h3 className="mb-4 flex items-center gap-2.5 text-base font-semibold">
              <Mic size={17} /> Audio
            </h3>
            <label className="my-5 flex items-center justify-between gap-5 text-sm">
              <div>
                <strong className="text-sm">Noise suppression</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  Reduce background noise from your microphone.
                </p>
              </div>
              <input
                className="relative m-0 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full border bg-input p-0 transition-colors before:absolute before:top-[3px] before:left-[3px] before:size-3 before:rounded-full before:bg-foreground before:transition-[left] before:content-[''] checked:border-primary checked:bg-primary checked:before:left-[17px] checked:before:bg-primary-foreground"
                type="checkbox"
                checked={noise}
                onChange={(e) => {
                  localStorage.setItem(
                    'bc-noise',
                    e.target.checked ? 'on' : 'off',
                  );
                  setNoise(e.target.checked);
                  window.dispatchEvent(new Event('bc-noise'));
                }}
              />
            </label>
            <label className="my-5 flex items-center justify-between gap-5 text-sm">
              <div>
                <strong className="text-sm">Balance voices</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  Gently even out the people you hear.
                </p>
              </div>
              <input
                className="relative m-0 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full border bg-input p-0 transition-colors before:absolute before:top-[3px] before:left-[3px] before:size-3 before:rounded-full before:bg-foreground before:transition-[left] before:content-[''] checked:border-primary checked:bg-primary checked:before:left-[17px] checked:before:bg-primary-foreground"
                type="checkbox"
                checked={balanced}
                onChange={(e) => setBalanced(e.target.checked)}
              />
            </label>
            <MediaSettings />
            <h3 className="mt-7 mb-4 flex items-center gap-2.5 text-base font-semibold">
              <SunMoon size={17} /> Appearance
            </h3>
            <div className="my-5 flex items-center justify-between gap-5">
              <div>
                <strong className="text-sm">Theme</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  Light, dark, or match your system.
                </p>
              </div>
              <ModeToggle />
            </div>
            <h3 className="mt-7 mb-4 flex items-center gap-2.5 text-base font-semibold">
              <LayoutPanelTop size={17} /> Layout
            </h3>
            <label className="my-4 block text-xs font-medium leading-7 text-foreground/80">
              Camera placement
              <select
                className="mt-2"
                value={layout}
                onChange={(e) => setLayout(e.target.value)}
              >
                <option value="top">Cameras on top</option>
                <option value="side">Cameras on the side</option>
                <option value="right">Cameras on the right</option>
              </select>
            </label>
            {user && (
              <Button
                variant="ghost"
                className="mt-6"
                onClick={() =>
                  run(async () => {
                    await api('/auth/logout', {}, 'POST');
                    setUser(null);
                    setRooms([]);
                    setRoom(null);
                    setSettings(false);
                  })
                }
              >
                <LogOut size={16} /> Sign out
              </Button>
            )}
          </div>
        </WorkspaceScreen>
      )}
    </div>
  );
}
