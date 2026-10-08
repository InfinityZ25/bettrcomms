import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClipSegment } from './clipBuffer';
import { renderClip } from './clipRenderer';

const assets = new Map<Blob, { name: string; delay: number }>();
const urls = new Map<string, { name: string; delay: number }>();
const media: FakeMedia[] = [];
const recorders: FakeRecorder[] = [];
const contexts: FakeContext[] = [];
const generatedTracks: { stop: ReturnType<typeof vi.fn> }[] = [];
let resume: () => Promise<void>;

class FakeMedia extends EventTarget {
  src = '';
  preload = '';
  muted = false;
  paused = true;
  readyState = 2;
  duration = Infinity;
  plays: { time: number; offset: number; asset: string }[] = [];
  seeks: { time: number; offset: number; asset: string }[] = [];
  private offset = 0;
  private origin = 0;
  constructor() {
    super();
    media.push(this);
  }
  get currentTime() {
    return (
      this.offset + (this.paused ? 0 : (performance.now() - this.origin) / 1000)
    );
  }
  set currentTime(value: number) {
    this.offset = value;
    this.origin = performance.now();
    this.seeks.push({
      time: this.origin,
      offset: value,
      asset: urls.get(this.src)?.name ?? '',
    });
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
  }
  setAttribute() {}
  removeAttribute() {
    this.src = '';
  }
  load() {
    const asset = urls.get(this.src);
    if (!asset) return;
    this.offset = 0;
    this.paused = true;
    setTimeout(
      () => this.dispatchEvent(new Event('loadedmetadata')),
      asset.delay,
    );
  }
  play() {
    this.plays.push({
      time: performance.now(),
      offset: this.currentTime,
      asset: urls.get(this.src)?.name ?? '',
    });
    this.offset = this.currentTime;
    this.origin = performance.now();
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.offset = this.currentTime;
    this.paused = true;
  }
}
class FakeVideo extends FakeMedia {
  videoWidth = 320;
  videoHeight = 180;
}
class FakeStream {
  constructor(private tracks: { stop: ReturnType<typeof vi.fn> }[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}
function track() {
  const value = { stop: vi.fn() };
  generatedTracks.push(value);
  return value;
}
class FakeContext {
  destination = {};
  close = vi.fn(async () => {});
  constructor() {
    contexts.push(this);
  }
  resume() {
    return resume();
  }
  createMediaStreamDestination() {
    return { stream: new FakeStream([track()]) };
  }
  createMediaElementSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
}
class FakeRecorder {
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'video/webm';
  startedAt = 0;
  ondataavailable?: (event: BlobEvent) => void;
  onstop?: () => void;
  onerror?: () => void;
  constructor() {
    recorders.push(this);
  }
  start() {
    this.startedAt = performance.now();
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['encoded']) } as BlobEvent);
      this.onstop?.();
    });
  }
}
function segment(
  name: string,
  source: ClipSegment['source'],
  startMs: number,
  endMs: number,
  delay = 0,
): ClipSegment {
  const blob = new Blob([name]);
  assets.set(blob, { name, delay });
  return { id: name, peerId: 'friend', source, startMs, endMs, blob };
}
function canvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      fillText: vi.fn(),
    }),
    captureStream: () => new FakeStream([track()]),
  } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  assets.clear();
  urls.clear();
  media.length = 0;
  recorders.length = 0;
  contexts.length = 0;
  generatedTracks.length = 0;
  resume = async () => {};
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'performance',
    ],
  });
  vi.stubGlobal('document', {
    createElement: (name: string) =>
      name === 'video' ? new FakeVideo() : new FakeMedia(),
  });
  vi.stubGlobal('HTMLVideoElement', FakeVideo);
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:clip-${urls.size}`;
    urls.set(url, assets.get(blob as Blob)!);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('prepares all initial sources before playback and starts recording at their common origin', async () => {
  const result = renderClip({
    window: {
      startMs: 0,
      endMs: 1000,
      segments: [
        segment('video', 'screen', 0, 1000, 200),
        segment('audio', 'microphone', 0, 1000),
      ],
    },
    startMs: 0,
    endMs: 1000,
    videoKey: 'friend:screen',
    audioKeys: ['friend:microphone'],
    title: 'Moment',
    signal: new AbortController().signal,
    canvas: canvas(),
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(media.every((player) => player.plays.length === 0)).toBe(true);
  expect(recorders).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1200);
  expect(await result).toBeInstanceOf(Blob);
  expect(media.map((player) => player.plays[0]!.time)).toEqual([200, 200]);
  expect(recorders[0]!.startedAt).toBe(200);
  expect(media.every((player) => player.paused && !player.src)).toBe(true);
  expect(contexts[0]!.close).toHaveBeenCalledOnce();
  expect(
    generatedTracks.every((value) => value.stop.mock.calls.length >= 1),
  ).toBe(true);
});

it('seeks a delayed transition to the current common clock rather than the pre-decode offset', async () => {
  const result = renderClip({
    window: {
      startMs: 0,
      endMs: 2000,
      segments: [
        segment('first', 'microphone', 0, 1000),
        segment('second', 'microphone', 1000, 2000, 250),
      ],
    },
    startMs: 0,
    endMs: 2000,
    audioKeys: ['friend:microphone'],
    title: 'Moment',
    signal: new AbortController().signal,
    canvas: canvas(),
  });
  await vi.advanceTimersByTimeAsync(2200);
  expect(await result).toBeInstanceOf(Blob);
  const transition = media[0]!.plays.find((play) => play.asset === 'second')!;
  expect(transition.offset).toBeGreaterThanOrEqual(0.25);
  expect(transition.offset).toBeCloseTo((transition.time - 1000) / 1000, 2);
});

it('aborting a pending audio startup releases the context and generated tracks', async () => {
  resume = () => new Promise(() => {});
  const controller = new AbortController();
  const result = renderClip({
    window: { startMs: 0, endMs: 1000, segments: [] },
    startMs: 0,
    endMs: 1000,
    audioKeys: [],
    title: 'Moment',
    signal: controller.signal,
    canvas: canvas(),
  });
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(contexts[0]!.close).toHaveBeenCalledOnce();
  expect(
    generatedTracks.every((value) => value.stop.mock.calls.length >= 1),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
