import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from '@/api';
import {
  notificationDeviceId,
  notificationPolicyTime,
  notificationSnapshot,
  refreshNotificationPolicy,
  roomIsMuted,
  setAccountDoNotDisturb,
  setDoNotDisturb,
  setRoomNotificationMode,
  setRoomTimedMute,
  startNotificationSession,
} from '@/features/chat/notificationSettings';
import type { QuietHours } from './api';

vi.mock('@/api', async (original) => ({
  ...(await original<typeof import('@/api')>()),
  api: vi.fn(),
}));
vi.mock('@/desktop/notifications', () => ({
  desktopNotificationsAvailable: () => false,
  requestDesktopNotificationAuthorization: vi.fn(),
}));
let stop: (() => void) | undefined;
let quiet: QuietHours;
let preferences: {
  rooms: Record<string, 'all' | 'mentions' | 'mute'>;
  muted_until: Record<string, string>;
  versions: Record<string, number>;
};
let conflict: boolean;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  const values = new Map<string, string>();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  quiet = {
    version: 1,
    enabled: true,
    timezone: 'America/Mexico_City',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    start_time: '23:00',
    end_time: '08:00',
    active: false,
    server_time: '2026-10-11T12:00:00Z',
    account_dnd: false,
  };
  preferences = {
    rooms: { room: 'mentions' },
    muted_until: {},
    versions: { room: 2 },
  };
  conflict = false;
  vi.mocked(api).mockImplementation(async (path, body, method) => {
    if (path === '/me/quiet-hours') return { ...quiet };
    if (method !== 'PUT') return structuredClone(preferences);
    const input = body as {
      expected_version: number;
      mode?: 'all' | 'mentions' | 'mute';
      muted_until?: string | null;
    };
    if (conflict) {
      conflict = false;
      preferences.rooms.room = 'mute';
      preferences.versions.room++;
      throw new ApiRequestError('Changed', 409);
    }
    if (input.expected_version !== preferences.versions.room)
      throw new ApiRequestError('Changed', 409);
    if (input.mode) preferences.rooms.room = input.mode;
    if (input.muted_until !== undefined) {
      if (input.muted_until) preferences.muted_until.room = input.muted_until;
      else delete preferences.muted_until.room;
    }
    preferences.versions.room++;
    return {};
  });
});
afterEach(() => {
  setAccountDoNotDisturb('alice', false);
  stop?.();
  stop = undefined;
  vi.mocked(api).mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function start() {
  stop = startNotificationSession('alice');
  await vi.advanceTimersByTimeAsync(0);
}
describe('shared quiet policy and timed mute', () => {
  it('keeps account quiet, manual availability and local quiet cumulative without altering the underlying mode', async () => {
    quiet.active = true;
    await start();
    expect(notificationSnapshot().dnd).toBe(true);
    expect(notificationSnapshot().rooms.room).toBe('mentions');
    setDoNotDisturb(true);
    quiet.active = false;
    await refreshNotificationPolicy();
    expect(notificationSnapshot().dnd).toBe(true);
    setDoNotDisturb(false);
    setAccountDoNotDisturb('alice', true);
    expect(notificationSnapshot().dnd).toBe(true);
    setAccountDoNotDisturb('alice', false);
    expect(notificationSnapshot().dnd).toBe(false);
  });
  it('restores the underlying mentions mode after a timed mute, and does not resume permanent mute', async () => {
    await start();
    await setRoomTimedMute('room', new Date('2026-10-11T12:01:00Z'));
    expect(roomIsMuted('room')).toBe(true);
    expect(notificationSnapshot().rooms.room).toBe('mentions');
    await setRoomTimedMute('room', null);
    expect(roomIsMuted('room')).toBe(false);
    expect(notificationSnapshot().rooms.room).toBe('mentions');
    await setRoomNotificationMode('room', 'mute');
    await setRoomTimedMute('room', null);
    expect(roomIsMuted('room')).toBe(true);
  });
  it('retries a sparse timed-mute CAS against a changed version without overwriting the concurrent mode', async () => {
    await start();
    conflict = true;
    await setRoomTimedMute('room', new Date('2026-10-11T12:01:00Z'));
    expect(notificationSnapshot()).toMatchObject({
      rooms: { room: 'mute' },
      versions: { room: 4 },
      mutedUntil: { room: '2026-10-11T12:01:00.000Z' },
    });
    const calls = vi
      .mocked(api)
      .mock.calls.filter(([, , method]) => method === 'PUT');
    expect(calls[0][1]).toMatchObject({ expected_version: 2 });
    expect(calls[1][1]).toMatchObject({ expected_version: 3 });
    expect(calls[1][1]).not.toHaveProperty('mode');
  });
  it('anchors mute expiry to server time despite a skewed device clock', async () => {
    preferences.muted_until.room = '2026-10-11T12:01:00Z';
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    await start();
    expect(notificationPolicyTime()).toBe(Date.parse(quiet.server_time));
    expect(roomIsMuted('room')).toBe(true);
    expect(
      roomIsMuted(
        'room',
        notificationSnapshot(),
        Date.parse('2026-10-11T12:01:00Z'),
      ),
    ).toBe(false);
  });
  it('uses stable account-specific device identities without leaking them across accounts', async () => {
    await start();
    expect(notificationDeviceId()).toBe(notificationDeviceId('alice'));
    expect(notificationDeviceId('alice')).not.toBe(notificationDeviceId('bob'));
  });
});
