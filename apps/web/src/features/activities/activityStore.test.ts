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
    await vi.waitFor(() => expect(store.snapshot().loading).toBe(false));
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
    await vi.waitFor(() =>
      expect(store.snapshot().data.watch?.room_id).toBe('private-room'),
    );
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

  it('holds all concurrent callers until the queued mutation refresh publishes its final revision', async () => {
    mocks.api.mockResolvedValueOnce(privateData);
    const store = createChannelActivityStore('room');
    const close = store.start();
    await vi.waitFor(() => expect(store.snapshot().loading).toBe(false));
    const beforeMutation = deferred<ChannelActivitySnapshot>();
    const afterMutation = deferred<ChannelActivitySnapshot>();
    mocks.api
      .mockReturnValueOnce(beforeMutation.promise)
      .mockReturnValueOnce(afterMutation.promise);
    const revisions: (number | undefined)[] = [];
    const off = store.subscribe(() =>
      revisions.push(store.snapshot().data.watch?.revision),
    );
    let firstSettled = false;
    let queuedSettled = false;
    const first = store.load().then(() => {
      firstSettled = true;
    });
    const queued = store.load().then(() => {
      queuedSettled = true;
    });
    void store.load();
    expect(mocks.api).toHaveBeenCalledTimes(2);
    beforeMutation.resolve({
      ...privateData,
      watch: { ...privateData.watch!, revision: 2 },
    });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(3));
    expect(firstSettled).toBe(false);
    expect(queuedSettled).toBe(false);
    expect(store.snapshot().data.watch?.revision).toBe(1);
    expect(revisions).not.toContain(2);
    afterMutation.resolve({
      ...privateData,
      watch: { ...privateData.watch!, revision: 3 },
    });
    await Promise.all([first, queued]);
    expect(firstSettled).toBe(true);
    expect(queuedSettled).toBe(true);
    expect(store.snapshot().data.watch?.revision).toBe(3);
    expect(revisions).toEqual([3]);
    off();
    close();
  });

  it('keeps the same awaited batch open when another mutation queues a third serial read', async () => {
    mocks.api.mockResolvedValueOnce(privateData);
    const store = createChannelActivityStore('room');
    const close = store.start();
    await vi.waitFor(() => expect(store.snapshot().loading).toBe(false));
    const beforeFirstMutation = deferred<ChannelActivitySnapshot>();
    const beforeSecondMutation = deferred<ChannelActivitySnapshot>();
    const latest = deferred<ChannelActivitySnapshot>();
    mocks.api
      .mockReturnValueOnce(beforeFirstMutation.promise)
      .mockReturnValueOnce(beforeSecondMutation.promise)
      .mockReturnValueOnce(latest.promise);
    let settled = false;
    const first = store.load().then(() => {
      settled = true;
    });
    const second = store.load();
    beforeFirstMutation.resolve(privateData);
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(3));
    const third = store.load();
    beforeSecondMutation.resolve(privateData);
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(4));
    expect(settled).toBe(false);
    latest.resolve({ ...privateData, watch: null });
    await Promise.all([first, second, third]);
    expect(settled).toBe(true);
    expect(store.snapshot().data.watch).toBeNull();
    close();
  });

  it('settles queued callers and clears private state when the final refresh loses permission', async () => {
    mocks.api.mockResolvedValueOnce(privateData);
    const store = createChannelActivityStore('room');
    const close = store.start();
    await vi.waitFor(() => expect(store.snapshot().loading).toBe(false));
    const stale = deferred<ChannelActivitySnapshot>();
    const denied = deferred<ChannelActivitySnapshot>();
    mocks.api
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(denied.promise);
    const first = store.load();
    const queued = store.load();
    stale.resolve(privateData);
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(3));
    denied.reject(new ApiRequestError('Access removed', 403));
    await Promise.all([first, queued]);
    expect(store.snapshot().data).toEqual({
      polls: [],
      events: [],
      assets: [],
      watch: null,
    });
    expect(store.snapshot().error).toBe('Access removed');
    expect(store.snapshot().loading).toBe(false);
    close();
  });

  it('settles in-flight and queued callers on close even when the transport ignores abort', async () => {
    mocks.api.mockResolvedValueOnce(privateData);
    const store = createChannelActivityStore('room');
    const close = store.start();
    await vi.waitFor(() => expect(store.snapshot().loading).toBe(false));
    const stalled = deferred<ChannelActivitySnapshot>();
    mocks.api.mockReturnValueOnce(stalled.promise);
    const first = store.load();
    const queued = store.load();
    const requestSignal = mocks.api.mock.calls.at(-1)![3] as AbortSignal;
    let duringClose: Promise<void> | undefined;
    const off = store.subscribe(() => {
      if (!store.snapshot().data.watch) duringClose = store.load();
    });
    close();
    await Promise.all([first, queued, duringClose]);
    expect(requestSignal.aborted).toBe(true);
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(store.snapshot().data.watch).toBeNull();
    stalled.resolve(privateData);
    await stalled.promise;
    await Promise.resolve();
    expect(store.snapshot().data.watch).toBeNull();
    await store.load();
    expect(mocks.api).toHaveBeenCalledTimes(2);
    off();
  });

  it('settles a discarded queued batch on restart and never publishes its old room data', async () => {
    const discarded = deferred<ChannelActivitySnapshot>();
    const latest = deferred<ChannelActivitySnapshot>();
    mocks.api
      .mockReturnValueOnce(discarded.promise)
      .mockReturnValueOnce(latest.promise);
    const store = createChannelActivityStore('room');
    const closeFirst = store.start();
    const queuedFirst = store.load();
    const queuedSecond = store.load();
    const closeLatest = store.start();
    await Promise.all([queuedFirst, queuedSecond]);
    expect(mocks.api.mock.calls[0][3].aborted).toBe(true);
    expect(mocks.api).toHaveBeenCalledTimes(2);
    latest.resolve({ ...privateData, watch: null });
    await vi.waitFor(() => expect(store.snapshot().loading).toBe(false));
    closeFirst();
    expect(mocks.api.mock.calls[1][3].aborted).toBe(false);
    discarded.resolve(privateData);
    await discarded.promise;
    await Promise.resolve();
    expect(store.snapshot().data.watch).toBeNull();
    closeLatest();
  });
});
