import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import {
  notificationSnapshot,
  setRoomNotificationMode,
  startNotificationSession,
} from './notificationSettings';

vi.mock('@/api', () => ({ api: vi.fn() }));

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.mocked(api).mockReset();
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
});
