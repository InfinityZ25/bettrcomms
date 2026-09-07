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
  Users,
  Video,
  Volume2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from './components/ui/button';
import { Dialog } from './components/ui/dialog';
import { api, type User, type Room, type Message, type CallParticipant } from './api';
import CallStage, { type NativeShareActions } from './CallStage';
import NativeScreenPicker from './NativeScreenPicker';
import FriendsPanel from './FriendsPanel';
import MediaSettings from './MediaSettings';
import RoomSettings from './RoomSettings';
import RecordingsLibrary from './RecordingsLibrary';
import WorkspaceScreen from './WorkspaceScreen';
import RoomNavigation, { roomLabel } from './RoomNavigation';
import { useCallPresence } from './useCallPresence';

type Screen = 'call' | 'settings' | 'recordings' | 'share';
const emptyCall: CallParticipant[] = [];
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
    <span className={'avatar ' + (large ? 'avatar-large' : '')}>
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
    [layout, setLayout] = useState(localStorage.getItem('bc-layout') === 'focus' ? 'top' : localStorage.getItem('bc-layout') ?? 'top'),
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
  useEffect(() => { if (callJoined) setChat(false); }, [callJoined]);
  useEffect(() => {
    const restore = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.fullscreenElement && !document.querySelector('[role="dialog"]')) setCallFocused(false); };
    window.addEventListener('keydown', restore); return () => window.removeEventListener('keydown', restore);
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
    const timer = setInterval(() => loadRooms().catch(() => {}), 10000);
    return () => clearInterval(timer);
  }, [user]);
  useEffect(() => {
    setMessages([]);
    if (!room) return;
    let active = true;
    const refresh = () =>
      api<{ messages: Message[] }>('/rooms/' + room.id + '/messages')
        .then((r) => {
          if (active) setMessages(r.messages ?? []);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [room?.id]);
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
      await api('/rooms/' + room.id + '/messages', { body: draft });
      setDraft('');
      const r = await api<{ messages: Message[] }>(
        '/rooms/' + room.id + '/messages',
      );
      setMessages(r.messages ?? []);
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
      <div className="boot">
        <AudioLines size={36} />
        <span>Opening your space…</span>
      </div>
    );
  return (
    <div className={`app-shell${callJoined ? " is-in-call" : ""}${callJoined && callFocused && screen === "call" ? " is-call-focused" : ""}`}>
      <nav
        className="space-rail"
        aria-label="Spaces"
        inert={screen === 'share'}
      >
        <a className="brand-mark" href="/" aria-label="Bettercomms home">
          <AudioLines />
        </a>
        <div className="rail-divider" />
        <button
          className="space-icon active"
          onClick={() => setFriends(true)}
          aria-label="Friends"
        >
          <Users size={22} />
        </button>
        {rooms.slice(0, 5).map((r) => (
          <button
            key={r.id}
            className={'space-icon ' + (room?.id === r.id ? 'selected' : '')}
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
          className="space-icon add"
          aria-label="Create a space"
          onClick={() => setCreate(true)}
        >
          <Plus />
        </button>
        <button
          className={
            'space-icon ' + (screen === 'recordings' ? 'selected' : '')
          }
          aria-current={screen === 'recordings' ? 'page' : undefined}
          aria-label="Recordings"
          title="Recordings"
          onClick={() => setRecordingsOpen(true)}
        >
          <Clapperboard size={21} />
        </button>
        <div className="rail-bottom">
          <button
            className={
              'space-icon ' + (screen === 'settings' ? 'selected' : '')
            }
            aria-current={screen === 'settings' ? 'page' : undefined}
            aria-label="Audio and video settings"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={21} />
          </button>
          {user ? <Avatar name={user.name} /> : <span className="online-dot" />}
        </div>
      </nav>
      <aside className="sidebar" inert={screen === 'share'}>
        <div className="workspace-name">
          Your space <ChevronDown size={16} />
        </div>
        <button className="nav-item" onClick={() => setFriends(true)}>
          <Users size={18} /> Friends <span className="nav-arrow">↗</span>
        </button>
        <RoomNavigation rooms={rooms} selected={room?.id} presence={presence.rooms} known={presence.known}
          onSelect={(next) => { setRoom(next); navigate('call'); }} onCreate={() => setCreate(true)} />
        <div className="sidebar-note">
          <span className="note-symbol">
            <Headphones size={20} />
          </span>
          <strong>
            Good company.
            <br />
            Room to be yourself.
          </strong>
          <p>Your calls, the way you like them.</p>
        </div>
        <div className="profile-bar">
          <Avatar name={user?.name ?? 'You'} />
          <div>
            <strong>{user?.name ?? 'Welcome in'}</strong>
            <span>
              <i className="online-dot" />
              {user ? 'Available' : 'Make yourself at home'}
            </span>
          </div>
          <button aria-label="Settings" onClick={() => setSettings(true)}>
            <Settings2 size={18} />
          </button>
        </div>
      </aside>
      <main className="main" aria-label="Call" hidden={screen !== 'call'}>
        <header className="room-header">
          <div className="room-heading">
            {room?.kind === 'direct' ? <MessageSquare size={22} /> : <Hash size={22} />}
            <strong>{room ? roomLabel(room) : 'The living room'}</strong>
            <span className="header-divider" />
            <span className="room-description">{room?.kind === 'direct' ? 'Direct conversation' : 'A place to hang out'}</span>
          </div>
          <div className="header-actions">
            {callJoined && callRoom && room?.id !== callRoom.id && (
              <Button variant="secondary" className="return-to-call" onClick={() => setRoom(callRoom)}>
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
            <span className="private-label">
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
        <div className="room-body">
          <section className="call-area">
            {!user && <div className="call-title">
              <div>
                <span className="eyebrow">MAKE ROOM FOR YOUR PEOPLE</span>
                <h1>
                  {user ? 'Better together.' : 'A little closer, wherever.'}
                </h1>
                <p>
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
            </div>}
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
              onFocus={() => setCallFocused(value => !value)}
              noise={noise}
              balanced={balanced}
              callPresence={(callJoined ? callRoom : room) ? presence.rooms[(callJoined ? callRoom : room)!.id] ?? emptyCall : emptyCall}
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
              <div id="signin" className="signin-card">
                <div>
                  <strong>Your people are one sign-in away.</strong>
                  <p>
                    Sign in securely to create rooms and invite your friends.
                  </p>
                </div>
                <Button onClick={() => location.assign('/api/v1/auth/login')}>
                  Continue with WorkOS <ArrowRight size={17} />
                </Button>
                {devAuth && (
                  <form className="dev-login" onSubmit={login}>
                    <span>Local development</span>
                    <input
                      aria-label="Your name"
                      placeholder="Your name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                    <input
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
            <aside className="chat-panel">
              <div className="chat-heading">
                <strong>Room chat</strong>
                <button onClick={() => setChat(false)} aria-label="Close chat">
                  <X size={17} />
                </button>
              </div>
              <div className="chat-messages">
                {!messages.length ? (
                  <div className="chat-welcome">
                    <span className="chat-welcome-icon">
                      <MessageSquare size={24} />
                    </span>
                    <h3>The conversation starts here.</h3>
                    <p>
                      A link, a thought, a very important meme.
                      <br />
                      Drop it in.
                    </p>
                    <span className="date-rule">TODAY</span>
                  </div>
                ) : (
                  messages.map((m) => (
                    <div className="message" key={m.id}>
                      <Avatar name={m.author.name} />
                      <div>
                        <div className="message-meta">
                          <strong>{m.author.name}</strong>
                          <time>
                            {new Date(m.created_at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        </div>
                        <p>{m.body}</p>
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEnd} />
              </div>
              <form className="chat-compose" onSubmit={send}>
                <input
                  placeholder={
                    user ? 'Message your room…' : 'Sign in to say hello'
                  }
                  aria-label="Message your room"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={!user || !room}
                />
                <button
                  aria-label="Send message"
                  disabled={!draft.trim() || busy}
                >
                  <Send size={17} />
                </button>
              </form>
              <span className="chat-caption">
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
        <div className="toast" role="alert">
          <CircleHelp size={18} />
          {error}
          <button
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
      />
      <Dialog
        open={create}
        onOpenChange={setCreate}
        title="Make a little room"
        description="A private place for your calls, screen shares, and conversations."
      >
        <form
          className="modal-form"
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
          <label>
            Room name
            <input
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
        <div className="modal-form">
          {user ? (
            <>
              <label>
                Your user ID
                <div className="copy-field">
                  <input readOnly value={user.id} />
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
          <div className="settings-section">
            <h3>
              <Mic size={17} /> Audio
            </h3>
            <label className="switch-row">
              <div>
                <strong>Noise suppression</strong>
                <p>Reduce background noise from your microphone.</p>
              </div>
              <input
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
            <label className="switch-row">
              <div>
                <strong>Balance voices</strong>
                <p>Gently even out the people you hear.</p>
              </div>
              <input
                type="checkbox"
                checked={balanced}
                onChange={(e) => setBalanced(e.target.checked)}
              />
            </label>
            <MediaSettings />
            <h3>
              <LayoutPanelTop size={17} /> Layout
            </h3>
            <label>
              Camera placement
              <select
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
