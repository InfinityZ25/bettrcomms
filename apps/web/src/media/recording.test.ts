import { beforeEach, expect, it, vi } from 'vitest';
import { TrackRecordingSession, type RecordableTrack } from './recording';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  nativeTrackId: undefined as string | undefined,
}));
vi.mock('../desktop/capture', () => ({ invokeNativeCapture: mocks.invoke }));
vi.mock('./nativeCaptureRegistry', () => ({
  nativeScreenSessionForTrack: (track: MediaStreamTrack) =>
    track.id === mocks.nativeTrackId ? 'capture-session' : undefined,
}));

const constructorCalls: Array<{ options?: MediaRecorderOptions }> = [];
const recorderInstances: FakeMediaRecorder[] = [];

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported = () => true;
  readonly mimeType: string;
  state: RecordingState = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? '';
    constructorCalls.push({ options });
    recorderInstances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    this.onstop?.();
    this.dispatchEvent(new Event('stop'));
  }
}

class QueuedMediaRecorder extends FakeMediaRecorder {
  stopCalls = 0;

  override stop(): void {
    this.stopCalls++;
    this.state = 'inactive';
  }

  flushStop(): void {
    this.ondataavailable?.({
      data: new Blob(['final recording data'], { type: 'audio/webm' }),
    } as BlobEvent);
    this.onstop?.();
    this.dispatchEvent(new Event('stop'));
  }
}

class FakeTrack extends EventTarget {
  readonly stop = vi.fn();

  constructor(
    readonly id: string,
    readonly kind: 'audio' | 'video',
  ) {
    super();
  }
}

function descriptor(
  id: string,
  kind: 'audio' | 'video',
  source: RecordableTrack['source'],
): RecordableTrack {
  return {
    peerId: 'peer',
    source,
    track: new FakeTrack(id, kind) as unknown as MediaStreamTrack,
  };
}

beforeEach(() => {
  constructorCalls.length = 0;
  recorderInstances.length = 0;
  mocks.invoke.mockReset();
  mocks.nativeTrackId = undefined;
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(_tracks: MediaStreamTrack[]) {}
    },
  );
});

it.each(['removed', 'ended'] as const)(
  'waits for queued final recording data after a track is %s',
  async (reason) => {
    vi.stubGlobal('MediaRecorder', QueuedMediaRecorder);
    const microphone = descriptor('microphone', 'audio', 'microphone');
    const session = new TrackRecordingSession();
    session.start([microphone], ['audio/webm']);
    const recorder = recorderInstances[0] as QueuedMediaRecorder;

    if (reason === 'removed') session.removeTrack(microphone.track.id);
    else microphone.track.dispatchEvent(new Event('ended'));
    expect(recorder.state).toBe('inactive');
    let settled = false;
    const pending = session.stop().then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completedBeforeFinalData = settled;
    recorder.flushStop();
    const result = await pending;

    expect(completedBeforeFinalData).toBe(false);
    expect(recorder.stopCalls).toBe(1);
    expect(result.manifest.tracks[0]).toMatchObject({
      status: 'complete',
      endedReason: 'track-ended',
      bytes: 20,
    });
    expect(await result.files[0].blob.text()).toBe('final recording data');
    expect((microphone.track as unknown as FakeTrack).stop).not.toHaveBeenCalled();
  },
);

it('retains the final chunk delivered after a recorder error', async () => {
  vi.stubGlobal('MediaRecorder', QueuedMediaRecorder);
  const onError = vi.fn();
  const session = new TrackRecordingSession({ onError });
  session.start([descriptor('microphone', 'audio', 'microphone')]);
  const recorder = recorderInstances[0] as QueuedMediaRecorder;
  recorder.state = 'inactive';
  recorder.onerror?.({ message: 'Encoder failed' } as ErrorEvent);
  let settled = false;
  const pending = session.stop().then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const completedBeforeFinalData = settled;
  recorder.flushStop();
  const result = await pending;

  expect(completedBeforeFinalData).toBe(false);
  expect(onError).toHaveBeenCalledOnce();
  expect(result.manifest.tracks[0]).toMatchObject({
    status: 'error',
    endedReason: 'recorder-error',
    error: 'Encoder failed',
    bytes: 20,
  });
  expect(await result.files[0].blob.text()).toBe('final recording data');
});

it('finishes without a stop event when recorder start fails', async () => {
  vi.stubGlobal('MediaRecorder', class extends FakeMediaRecorder {
    override start(): void {
      throw new Error('Encoder cannot start');
    }
  });
  const microphone = descriptor('microphone', 'audio', 'microphone');
  const removeListener = vi.spyOn(microphone.track, 'removeEventListener');
  const session = new TrackRecordingSession();
  session.start([microphone]);
  const result = await session.stop();

  expect(result.manifest.tracks[0]).toMatchObject({
    status: 'error',
    endedReason: 'recorder-error',
    error: 'Encoder cannot start',
    bytes: 0,
  });
  expect(removeListener).toHaveBeenCalledWith('ended', expect.any(Function));
  expect((microphone.track as unknown as FakeTrack).stop).not.toHaveBeenCalled();
});

it('imports a native screen pass-through MP4 once and releases its opaque asset', async () => {
  mocks.nativeTrackId = 'native-screen';
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'native_screen_recording_start') {
      expect(args).toEqual({ sessionId: 'capture-session' });
      return { recordingId: 'recording' };
    }
    if (command === 'native_screen_recording_stop') {
      expect(args).toEqual({ recordingId: 'recording' });
      return {
        assetId: 'asset',
        mimeType: 'video/mp4',
        sizeBytes: 4,
        startedDelayMs: 25,
        durationMs: 1_000,
      };
    }
    if (command === 'native_screen_recording_read') {
      expect(args).toEqual({
        assetId: 'asset',
        offset: 0,
        maxBytes: 256 * 1024,
      });
      return Uint8Array.from([0, 1, 2, 3]).buffer;
    }
    if (command === 'native_screen_recording_release') return;
    throw new Error(`Unexpected command ${command}`);
  });
  const native = descriptor('native-screen', 'video', 'screen');
  const session = new TrackRecordingSession();
  session.start([native]);
  (native.track as unknown as FakeTrack).dispatchEvent(new Event('ended'));
  const result = await session.stop();

  expect(constructorCalls).toHaveLength(0);
  expect(result.files[0].name).toMatch(/screen\.mp4$/);
  expect(new Uint8Array(await result.files[0].blob.arrayBuffer())).toEqual(
    Uint8Array.from([0, 1, 2, 3]),
  );
  expect(result.manifest.tracks[0]).toMatchObject({
    mimeType: 'video/mp4',
    durationMs: 1_000,
    bytes: 4,
    status: 'complete',
  });
  expect(result.manifest.tracks[0].startedOffsetMs).toBeGreaterThanOrEqual(25);
  expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
    'native_screen_recording_start',
    'native_screen_recording_stop',
    'native_screen_recording_read',
    'native_screen_recording_release',
  ]);
});

it('releases a native asset without reading when it exceeds the shared session limit', async () => {
  mocks.nativeTrackId = 'native-screen';
  mocks.invoke.mockImplementation(async (command) => {
    if (command === 'native_screen_recording_start')
      return { recordingId: 'recording' };
    if (command === 'native_screen_recording_stop')
      return {
        assetId: 'oversize',
        mimeType: 'video/mp4',
        sizeBytes: 5,
        startedDelayMs: 0,
        durationMs: 1,
      };
    if (command === 'native_screen_recording_release') return;
    throw new Error(`Unexpected command ${command}`);
  });
  const errors: string[] = [];
  const session = new TrackRecordingSession({
    maxBytes: 4,
    onError: (error) => errors.push(error.message),
  });
  session.start([descriptor('native-screen', 'video', 'screen')]);
  const result = await session.stop();

  expect(errors).toEqual([
    expect.stringContaining('remaining recording memory limit'),
  ]);
  expect(result.manifest.tracks[0]).toMatchObject({
    status: 'error',
    bytes: 0,
  });
  expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
    'native_screen_recording_start',
    'native_screen_recording_stop',
    'native_screen_recording_release',
  ]);
});

it('selects high-fidelity default bitrates by source and removes ended listeners on finish', async () => {
  const screen = descriptor('screen', 'video', 'screen');
  const camera = descriptor('camera', 'video', 'camera');
  const microphone = descriptor('microphone', 'audio', 'microphone');
  const removeSpies = [screen, camera, microphone].map(({ track }) =>
    vi.spyOn(track, 'removeEventListener'),
  );
  const session = new TrackRecordingSession();
  session.start([screen, camera, microphone], ['video/webm']);

  expect(constructorCalls.map(({ options }) => options)).toEqual([
    { mimeType: 'video/webm', videoBitsPerSecond: 20_000_000 },
    { mimeType: 'video/webm', videoBitsPerSecond: 8_000_000 },
    { mimeType: 'video/webm', audioBitsPerSecond: 256_000 },
  ]);
  await session.stop();
  for (const remove of removeSpies) {
    expect(remove).toHaveBeenCalledWith('ended', expect.any(Function));
  }
});

it('passes validated custom recording bitrates to each track recorder', () => {
  const session = new TrackRecordingSession({
    screenVideoBitsPerSecond: 32_000_000,
    cameraVideoBitsPerSecond: 12_000_000,
    audioBitsPerSecond: 320_000,
  });
  session.start([
    descriptor('screen', 'video', 'screen'),
    descriptor('camera', 'video', 'camera'),
    descriptor('system', 'audio', 'system'),
  ]);
  expect(constructorCalls.map(({ options }) => options)).toEqual([
    { videoBitsPerSecond: 32_000_000 },
    { videoBitsPerSecond: 12_000_000 },
    { audioBitsPerSecond: 320_000 },
  ]);
});

it('rejects invalid recording bitrate overrides', () => {
  expect(
    () => new TrackRecordingSession({ screenVideoBitsPerSecond: 100_000 }),
  ).toThrow(RangeError);
  expect(
    () => new TrackRecordingSession({ cameraVideoBitsPerSecond: Number.NaN }),
  ).toThrow(RangeError);
  expect(
    () => new TrackRecordingSession({ audioBitsPerSecond: 1_000_001 }),
  ).toThrow(RangeError);
});
