import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/api';
import type { ChannelActivitySnapshot } from './activityApi';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./activityApi', () => ({ api: mocks.api }));
vi.mock('@/features/call/useCallPresence', () => ({
  callPresenceSnapshot: () => ({ syncRevision: 0, roomsRevision: 0 }),
  subscribeCallPresence: () => () => {},
}));
import { createChannelActivityStore } from './activityStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const privateData: ChannelActivitySnapshot = {
  polls: [],
  events: [],
  assets: [],
  watch: {
    room_id: 'private-room',
    attachment: {
      id: 'private-video',
      filename: 'private.mp4',
      content_type: 'video/mp4',
      size_bytes: 100,
    },
    host_id: 'host',
    paused: true,
    position_seconds: 0,
    revision: 1,
    updated_at: '2026-10-01T10:00:00Z',
    server_time: '2026-10-01T10:00:00Z',
    can_claim: false,
  },
};
afterEach(() => {
  mocks.api.mockReset();
});
describe('activity subscription lifecycle', () => {
  it('survives the StrictMode setup-cleanup-setup cycle and ignores a response from the discarded mount', async () => {
    const first = deferred<typeof privateData>();
    const second = deferred<typeof privateData>();
    mocks.api
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = createChannelActivityStore('room');
    const closeFirst = store.start();
    closeFirst();
    const closeSecond = store.start();
    second.resolve({ ...privateData, watch: null });
    await second.promise;
    await Promise.resolve();
    expect(store.snapshot().loading).toBe(false);
    expect(store.snapshot().data.watch).toBeNull();
    first.resolve(privateData);
    await first.promise;
    await Promise.resolve();
    expect(store.snapshot().data.watch).toBeNull();
    expect(mocks.api.mock.calls[0][3].aborted).toBe(true);
    expect(mocks.api.mock.calls[1][3].aborted).toBe(false);
    closeSecond();
  });
  it('clears private assets and video immediately after permission revocation', async () => {
    mocks.api.mockResolvedValueOnce(privateData);
    const store = createChannelActivityStore('room');
    const close = store.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.snapshot().data.watch?.room_id).toBe('private-room');
    mocks.api.mockRejectedValueOnce(new ApiRequestError('Access removed', 403));
    await store.load();
    expect(store.snapshot().data).toEqual({
      polls: [],
      events: [],
      assets: [],
      watch: null,
    });
    expect(store.snapshot().error).toBe('Access removed');
    close();
  });
});
