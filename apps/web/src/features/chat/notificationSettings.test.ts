import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import {
  notificationSnapshot,
  setSystemNotifications,
  setDoNotDisturb,
  setRoomNotificationMode,
  startNotificationSession,
} from './notificationSettings';

vi.mock('@/api', () => ({ api: vi.fn() }));
const desktop = vi.hoisted(() => ({ available: false, authorise: vi.fn() }));
vi.mock('@/desktop/notifications', () => ({
  desktopNotificationsAvailable: () => desktop.available,
  requestDesktopNotificationAuthorization: desktop.authorise,
}));

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
  desktop.available = false;
  desktop.authorise.mockReset();
});

describe('notification preferences', () => {
  it('keeps a saved mode when an older preference request finishes later', async () => {
    let finishLoad!: (value: { rooms: Record<string, 'all' | 'mentions' | 'mute'> }) => void;
    vi.mocked(api).mockImplementation((_path, _body, method) =>
      method === 'PUT'
        ? Promise.resolve({})
        : new Promise((resolve) => { finishLoad = resolve; }),
    );
    stop = startNotificationSession('user');
    await setRoomNotificationMode('room', 'mute');
    finishLoad({ rooms: { room: 'all' } });
    await vi.waitFor(() => expect(notificationSnapshot().ready).toBe(true));
    expect(notificationSnapshot().rooms.room).toBe('mute');
  });

  it('retries a temporary load failure and becomes ready', async () => {
    vi.useFakeTimers();
    vi.mocked(api)
      .mockRejectedValueOnce(new Error('temporarily offline'))
      .mockResolvedValueOnce({ rooms: { room: 'mentions' } });
    stop = startNotificationSession('user');
    await vi.advanceTimersByTimeAsync(2000);
    expect(notificationSnapshot()).toMatchObject({ ready: true, rooms: { room: 'mentions' } });
  });

  it('does not enable browser notifications for another account after a delayed permission answer', async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
    });
    vi.stubGlobal('window', { Notification: true });
    let answer!: (permission: NotificationPermission) => void;
    vi.stubGlobal('Notification', {
      requestPermission: () => new Promise<NotificationPermission>((resolve) => { answer = resolve; }),
    });
    vi.mocked(api).mockResolvedValue({ rooms: {} });
    stop = startNotificationSession('alice');
    const pending = setSystemNotifications(true);
    stop();
    stop = startNotificationSession('bob');
    answer('granted');
    expect(await pending).toBe(false);
    expect(notificationSnapshot().alerts).toBe(false);
    expect(saved.has('bettercomms:notification:bob:alerts')).toBe(false);
  });

  it('registers, updates DND and removes a browser push subscription', async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
    });
    const key = new Uint8Array(65);
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      options: { applicationServerKey: key.buffer },
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/test', expirationTime: null, keys: { p256dh: 'key', auth: 'auth' } }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const registration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe: vi.fn().mockResolvedValue(subscription) } };
    vi.stubGlobal('window', { Notification: true, PushManager: true });
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn().mockResolvedValue('granted') });
    vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockResolvedValue(registration), ready: Promise.resolve(registration), getRegistration: vi.fn().mockResolvedValue({ pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }) } });
    vi.mocked(api).mockImplementation((path) => Promise.resolve(path === '/push/subscription' ? { public_key: btoa(String.fromCharCode(...key)) } : { rooms: {} }));
    stop = startNotificationSession('user');
    expect(await setSystemNotifications(true)).toBe(true);
    expect(notificationSnapshot().background).toBe(true);
    expect(vi.mocked(api)).toHaveBeenCalledWith('/push/subscription', { endpoint: subscription.endpoint, keys: { p256dh: 'key', auth: 'auth' }, dnd: false }, 'POST');
    setDoNotDisturb(true);
    await vi.waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith('/push/subscription', expect.objectContaining({ dnd: true }), 'POST'));
    await setSystemNotifications(false);
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.mocked(api)).toHaveBeenCalledWith('/push/subscription', { endpoint: subscription.endpoint }, 'DELETE');
  });

  it('uses native authorization on desktop without registering Web Push', async () => {
    desktop.available = true;
    desktop.authorise.mockResolvedValue(true);
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
    });
    vi.mocked(api).mockResolvedValue({ rooms: {} });
    stop = startNotificationSession('user');
    expect(await setSystemNotifications(true)).toBe(true);
    expect(notificationSnapshot().alerts).toBe(true);
    expect(saved.get('bettercomms:notification:user:alerts')).toBe('true');
    expect(desktop.authorise).toHaveBeenCalledOnce();
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/push/subscription')).toBe(false);
  });

  it('keeps desktop alerts off when macOS denies authorization', async () => {
    desktop.available = true;
    desktop.authorise.mockResolvedValue(false);
    vi.mocked(api).mockResolvedValue({ rooms: {} });
    stop = startNotificationSession('user');
    expect(await setSystemNotifications(true)).toBe(false);
    expect(notificationSnapshot()).toMatchObject({ alerts: false, error: expect.stringContaining('system settings') });
  });
});
