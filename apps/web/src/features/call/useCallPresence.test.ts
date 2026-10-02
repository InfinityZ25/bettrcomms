import { afterEach, describe, expect, it, vi } from 'vitest';
import { callPresenceSnapshot, startRealtimeSession } from './useCallPresence';
import { ownPresenceSnapshot } from '@/features/settings/presenceStore';
import { profileSnapshot } from '@/features/settings/profileStore';
import { clearAvatarCache } from '@/features/settings/avatarCache';
import { receiveMessage } from '@/features/chat/messageStore';

vi.mock('@/features/chat/messageStore', () => ({ receiveMessage: vi.fn(), reconcileMessaging: vi.fn(), refreshUnread: vi.fn() }));
vi.mock('@/features/chat/typingStore', () => ({ receiveTyping: vi.fn(), setTypingSocket: vi.fn() }));
vi.mock('@/features/settings/avatarCache', () => ({ clearAvatarCache: vi.fn() }));
vi.mock('@/features/chat/notificationSettings', () => ({ setAccountDoNotDisturb: vi.fn() }));
vi.mock('@/desktop/apiTransport', () => ({ apiSocketUrl: (path: string) => `wss://localhost${path}` }));
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => this.onclose?.());
  constructor(public url: string) { Socket.instances.push(this); }
  event(type: string, payload: unknown) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }); }
}
const user = { id: 'alice', name: 'Alice', email: 'alice@example.test', presence_status: 'online' as const };
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; Socket.instances = []; vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function connect() { vi.stubGlobal('WebSocket', Socket); stop = startRealtimeSession(user); return Socket.instances.at(-1)!; }
describe('shared realtime profile and presence events', () => {
  it('applies the own preference and effective contact status from reconnect snapshots', () => {
    const socket = connect();
    socket.event('app.ready', {
      online_user_ids: ['visible', 'hidden'],
      own_presence: { status: 'dnd' },
      contact_presence: [{ user_id: 'visible', online: true, status: 'idle' }, { user_id: 'hidden', online: false, status: 'offline' }],
    });
    expect(callPresenceSnapshot()).toMatchObject({ known: true, onlineUsers: { visible: true, hidden: false }, contactStatuses: { visible: 'idle', hidden: 'offline' } });
    expect(ownPresenceSnapshot()).toMatchObject({ userId: 'alice', status: 'dnd' });
  });
  it('updates call names and profiles without restarting the event socket', () => {
    const socket = connect();
    socket.event('call.presence', { room_id: 'room', participants: [{ user_id: 'friend', name: 'Old', muted: false, deafened: false, device_count: 1 }] });
    socket.event('user.profile', { user: { id: 'friend', name: 'New', username: 'new_name', bio: 'Hello', email: '', profile_version: 2 } });
    socket.event('user.profile', { user: { id: 'friend', name: 'Old stale event', email: '', profile_version: 1 } });
    expect(profileSnapshot().friend.name).toBe('New');
    expect(callPresenceSnapshot().rooms.room[0].name).toBe('New');
    expect(Socket.instances).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
  });
  it('uses presence events, rather than potentially older profile snapshots, for own status', () => {
    const socket = connect();
    socket.event('user.presence', { user_id: 'alice', online: false, status: 'offline', desired_status: 'invisible' });
    socket.event('user.profile', { user: { ...user, name: 'Updated' } });
    expect(ownPresenceSnapshot().status).toBe('invisible');
    expect(callPresenceSnapshot().contactStatuses.alice).toBe('offline');
  });
  it('forgets contact availability on disconnect and cancels all reconnect timers on logout', () => {
    vi.useFakeTimers();
    const socket = connect();
    socket.onopen?.();
    socket.event('user.presence', { user_id: 'friend', online: true, status: 'dnd' });
    socket.onclose?.();
    expect(callPresenceSnapshot()).toMatchObject({ known: false, onlineUsers: {}, contactStatuses: {} });
    stop?.(); stop = undefined;
    vi.advanceTimersByTime(60_000);
    expect(Socket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(clearAvatarCache).toHaveBeenCalled();
  });
  it('isolates old account events and cleanup from the new account', () => {
    const old = connect();
    const oldStop = stop!;
    stop = startRealtimeSession({ id: 'bob', name: 'Bob', email: '' });
    old.event('chat.message', { id: 'message', room_id: 'private' });
    old.event('user.profile', { user: { ...user, name: 'Old event' } });
    oldStop();
    expect(receiveMessage).not.toHaveBeenCalled();
    expect(callPresenceSnapshot().userId).toBe('bob');
    expect(ownPresenceSnapshot().userId).toBe('bob');
  });
});
