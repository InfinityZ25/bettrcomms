import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClipBuffer, clampClipRange } from './clipBuffer';
import type { RecordableTrack } from './recording';

const recorders: FakeRecorder[] = [];
class FakeTrack extends EventTarget {
  readyState = 'live';
  enabled = true;
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  constructor(
    readonly id: string,
    readonly kind: 'audio' | 'video',
  ) {
    super();
  }
  clone = vi.fn(() => new FakeTrack(`${this.id}-clone`, this.kind));
}
class FakeRecorder {
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType: string;
  ondataavailable?: (event: BlobEvent) => void;
  onstop?: (event: Event) => void;
  onerror?: (event: Event) => void;
  queued = false;
  constructor(
    readonly stream: { tracks: FakeTrack[] },
    options: MediaRecorderOptions,
  ) {
    this.mimeType = options.mimeType!;
    recorders.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop = vi.fn(() => {
    this.state = 'inactive';
    if (!this.queued) this.flush();
  });
  flush() {
    this.ondataavailable?.({
      data: new Blob(['header-payload'], { type: this.mimeType }),
    } as BlobEvent);
    this.onstop?.(new Event('stop'));
  }
}
const descriptor = (
  source: RecordableTrack['source'],
  id = source,
): RecordableTrack => ({
  peerId: 'friend',
  source,
  track: new FakeTrack(
    id,
    source === 'camera' || source === 'screen' ? 'video' : 'audio',
  ) as unknown as MediaStreamTrack,
});
beforeEach(() => {
  recorders.length = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: unknown[]) {}
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('produces independently decodable, separate source segments and never stops the live source', async () => {
  const mic = descriptor('microphone');
  const screen = descriptor('screen');
  const buffer = new ClipBuffer();
  buffer.reconcile([mic, screen]);
  vi.advanceTimersByTime(1200);
  const window = await buffer.snapshot();
  expect(window.segments.map((segment) => segment.source)).toEqual([
    'microphone',
    'screen',
  ]);
  expect(await window.segments[0]!.blob.text()).toBe('header-payload');
  expect(window.endMs).toBe(1200);
  await buffer.dispose();
  expect(recorders.every((recorder) => recorder.state === 'inactive')).toBe(
    true,
  );
  expect((mic.track as unknown as FakeTrack).clone).not.toHaveBeenCalled();
  expect((screen.track as unknown as FakeTrack).clone).not.toHaveBeenCalled();
  expect((mic.track as unknown as FakeTrack).stop).not.toHaveBeenCalled();
  expect((screen.track as unknown as FakeTrack).stop).not.toHaveBeenCalled();
});

it('evicts old and excessive data without losing the container header of retained segments', async () => {
  const buffer = new ClipBuffer({
    windowMs: 9000,
    segmentMs: 3000,
    maxBytes: 30,
  });
  buffer.reconcile([descriptor('camera')]);
  vi.advanceTimersByTime(30_000);
  const window = await buffer.snapshot();
  expect(buffer.retainedBytes).toBeLessThanOrEqual(30);
  expect(window.segments.length).toBe(2);
  expect(window.segments.every((segment) => segment.startMs >= 24_000)).toBe(
    true,
  );
  expect(await window.segments[0]!.blob.text()).toBe('header-payload');
  await buffer.dispose();
});

it('waits for queued final chunks when creating a clip and on disposal', async () => {
  const buffer = new ClipBuffer();
  buffer.reconcile([descriptor('microphone')]);
  const first = recorders[0]!;
  first.queued = true;
  vi.advanceTimersByTime(1000);
  let settled = false;
  const snapshot = buffer.snapshot().then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  first.flush();
  const window = await snapshot;
  expect(window.segments[0]!.blob.size).toBe(14);
  const next = recorders[1]!;
  next.queued = true;
  settled = false;
  const dispose = buffer.dispose().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  next.flush();
  await dispose;
  expect(buffer.retainedBytes).toBe(0);
});

it('waits for final data when a device recorder becomes inactive before its stop event', async () => {
  const buffer = new ClipBuffer();
  buffer.reconcile([descriptor('microphone')]);
  vi.advanceTimersByTime(1000);
  const recorder = recorders[0]!;
  recorder.state = 'inactive';
  recorder.queued = true;
  let ready = false;
  const snapshot = buffer.snapshot().then((window) => {
    ready = true;
    return window;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(recorder.stop).not.toHaveBeenCalled();
  recorder.flush();
  expect((await snapshot).segments[0]!.blob.size).toBe(14);
  await buffer.dispose();
});

it('removes ended sources and discards all data on stop', async () => {
  const mic = descriptor('microphone');
  const buffer = new ClipBuffer();
  buffer.reconcile([mic]);
  vi.advanceTimersByTime(1000);
  (mic.track as unknown as FakeTrack).readyState = 'ended';
  mic.track.dispatchEvent(new Event('ended'));
  expect(recorders[0]!.stop).toHaveBeenCalledOnce();
  await buffer.dispose();
  expect(buffer.retainedBytes).toBe(0);
  await expect(buffer.snapshot()).rejects.toThrow('stopped');
});

it('cleans up a recorder that fails during start rather than waiting forever', async () => {
  class BrokenRecorder extends FakeRecorder {
    override start() {
      throw new Error('codec failed');
    }
  }
  vi.stubGlobal('MediaRecorder', BrokenRecorder);
  const onError = vi.fn();
  const buffer = new ClipBuffer({ onError });
  const camera = descriptor('camera');
  buffer.reconcile([camera]);
  await buffer.dispose();
  expect(onError).toHaveBeenCalledOnce();
  expect((camera.track as unknown as FakeTrack).stop).not.toHaveBeenCalled();
  expect(recorders[0]!.onstop).toBeNull();
});

it('honors mute and push-to-talk release immediately, without waiting for reconciliation or rotation', async () => {
  const microphone = descriptor('microphone');
  const original = microphone.track as unknown as FakeTrack;
  const buffer = new ClipBuffer();
  buffer.reconcile([microphone]);
  const recorded = recorders[0]!.stream.tracks[0]!;
  expect(recorded).toBe(original);
  original.enabled = false;
  expect(recorded.enabled).toBe(false);
  original.enabled = true;
  expect(recorded.enabled).toBe(true);
  await buffer.dispose();
  expect(original.stop).not.toHaveBeenCalled();
  expect(original.clone).not.toHaveBeenCalled();
});

it('stops its recorder at the memory limit while preserving the live call track', async () => {
  const onError = vi.fn();
  const microphone = descriptor('microphone');
  const buffer = new ClipBuffer({ maxBytes: 2, onError });
  buffer.reconcile([microphone]);
  vi.advanceTimersByTime(5000);
  await buffer.dispose();
  expect(onError).toHaveBeenCalledOnce();
  expect(recorders[0]!.state).toBe('inactive');
  expect(buffer.retainedBytes).toBe(0);
  expect(
    (microphone.track as unknown as FakeTrack).stop,
  ).not.toHaveBeenCalled();
});

it('constrains a clip to its captured window and a maximum of 60 seconds', () => {
  const window = { segments: [], startMs: 10_000, endMs: 100_000 };
  expect(clampClipRange(window, -1000, 200_000)).toEqual({
    startMs: 10_000,
    endMs: 70_000,
  });
  expect(clampClipRange(window, 200_000, 200_001)).toEqual({
    startMs: 99_999,
    endMs: 100_000,
  });
});
