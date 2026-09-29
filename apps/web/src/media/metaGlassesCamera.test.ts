import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => vi.fn<(method: number) => Promise<void>>());
vi.mock('@/desktop/iosNativeBindings', () => ({
  callIOSNative: native,
  iosNativeBinding: { metaStart: 1, metaStop: 2, metaConnect: 3 },
}));
vi.mock('@/desktop/runtime', () => ({ readDesktopBootReport: () => ({ platform: 'ios' }) }));
import { reconnectMetaGlassesCamera, startMetaGlassesCamera } from './metaGlassesCamera';

class Track extends EventTarget { stop = vi.fn(); }
let tracks: Track[];
let events: EventTarget;
const emit = (detail: unknown) => events.dispatchEvent(Object.assign(new Event('bc-meta-camera'), { detail }));
const frame = () => emit({ kind: 'frame', jpeg: '', width: 360, height: 640 });

beforeEach(() => {
  vi.useFakeTimers();
  native.mockReset().mockResolvedValue(undefined);
  tracks = [];
  events = new EventTarget();
  vi.stubGlobal('window', Object.assign(events, { setTimeout, clearTimeout }));
  vi.stubGlobal('document', { createElement: () => {
    const track = new Track();
    tracks.push(track);
    return { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }),
      captureStream: () => ({ getVideoTracks: () => [track] }) };
  } });
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    set src(_value: string) { this.onload?.(); }
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('does not start an already cancelled camera request', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(startMetaGlassesCamera(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(native).not.toHaveBeenCalled();
  expect(tracks).toHaveLength(0);
});

it('cancels and releases a pending request even before the native binding returns', async () => {
  let finish!: () => void;
  native.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const request = startMetaGlassesCamera(controller.signal);
  const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  finish();
  await rejected;
  expect(native.mock.calls).toEqual([[1], [2]]);
  expect(tracks[0].stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancelling one pending consumer keeps the other consumer connected', async () => {
  const first = new AbortController();
  const request = startMetaGlassesCamera(first.signal);
  const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  const second = startMetaGlassesCamera();
  first.abort();
  await rejected;
  expect(native).not.toHaveBeenCalledWith(2);
  frame();
  const camera = await second;
  expect(tracks[1].stop).not.toHaveBeenCalled();
  camera.dispose();
  camera.dispose();
  expect(native.mock.calls.filter(([method]) => method === 2)).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('releases a failed startup so the next attempt can start cleanly', async () => {
  native.mockRejectedValueOnce(new Error('Native start failed'));
  await expect(startMetaGlassesCamera()).rejects.toThrow('Native start failed');
  const next = startMetaGlassesCamera();
  frame();
  const camera = await next;
  camera.dispose();
  expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('waits for fresh registration before completing reconnect', async () => {
  const request = reconnectMetaGlassesCamera();
  expect(native).toHaveBeenCalledWith(3);
  emit({ kind: 'registered' });
  await request;
  expect(vi.getTimerCount()).toBe(0);
});

it('cleans up a cancelled reconnect', async () => {
  const controller = new AbortController();
  const request = reconnectMetaGlassesCamera(controller.signal);
  const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it('does not unregister an active glasses camera', async () => {
  const request = startMetaGlassesCamera();
  frame();
  const camera = await request;
  await expect(reconnectMetaGlassesCamera()).rejects.toThrow('Turn off glasses video');
  expect(native).not.toHaveBeenCalledWith(3);
  camera.dispose();
});
