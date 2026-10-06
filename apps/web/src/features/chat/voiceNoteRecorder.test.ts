import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceNoteRecorder, VOICE_NOTE_MAX_BYTES, VOICE_NOTE_MAX_MS, voiceNoteMimeType, voiceNoteTime, type VoiceNoteState } from './voiceNoteRecorder';

class MicrophoneTrack extends EventTarget {
  readyState = 'live';
  stop = vi.fn(() => { this.readyState = 'ended'; });
}

class Recorder {
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn(() => { this.state = 'recording'; });
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['final audio frame']) });
    this.onstop?.();
  });
}

function microphone() {
  const track = new MicrophoneTrack();
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}

function harness(capture?: () => Promise<MediaStream>) {
  const mic = microphone();
  const recorder = new Recorder();
  const states: VoiceNoteState[] = [];
  let now = 0;
  const environment = {
    permission: vi.fn(async () => {}),
    capture: vi.fn(capture ?? (async () => mic.stream)),
    create: vi.fn(() => recorder as unknown as MediaRecorder),
    mime: () => 'audio/webm;codecs=opus',
    now: () => now,
  };
  const controller = new VoiceNoteRecorder((state) => states.push(state), environment);
  return { controller, environment, recorder, states, mic, setNow: (value: number) => { now = value; }, latest: () => states.at(-1)! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('voice note recording ownership and review', () => {
  it('starts only after permission, returns a local file and releases its microphone before review', async () => {
    const h = harness();
    expect(h.environment.capture).not.toHaveBeenCalled();
    await h.controller.start();
    expect(h.latest().phase).toBe('recording');
    expect(h.recorder.start).toHaveBeenCalledWith(250);
    h.recorder.ondataavailable?.({ data: new Blob(['first audio frame']) });
    h.setNow(1800);
    h.controller.stop();
    expect(h.latest().phase).toBe('review');
    expect(h.latest().durationMs).toBe(1800);
    expect(h.latest().file?.type).toBe('audio/webm;codecs=opus');
    expect(h.latest().file?.name).toMatch(/^voice-note-.*\.webm$/);
    expect(h.latest().file?.size).toBeGreaterThan(0);
    expect(h.mic.track.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.dispose();
  });

  it('cancels a pending permission without opening the microphone afterward', async () => {
    const h = harness();
    let grant!: () => void;
    h.environment.permission.mockImplementation(() => new Promise<void>((resolve) => { grant = resolve; }));
    const starting = h.controller.start();
    h.controller.cancel();
    grant();
    await starting;
    expect(h.environment.capture).not.toHaveBeenCalled();
    expect(h.latest().phase).toBe('idle');
    h.controller.dispose();
  });

  it('stops a stream arriving after close, room change or account change without updating the closed composer', async () => {
    let grant!: (stream: MediaStream) => void;
    const h = harness(() => new Promise<MediaStream>((resolve) => { grant = resolve; }));
    const starting = h.controller.start();
    await Promise.resolve();
    const late = microphone();
    const before = h.states.length;
    h.controller.dispose();
    grant(late.stream);
    await starting;
    expect(late.track.stop).toHaveBeenCalledTimes(1);
    expect(h.environment.create).not.toHaveBeenCalled();
    expect(h.states).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps the duration and ends the capture automatically', async () => {
    const h = harness();
    await h.controller.start();
    h.setNow(VOICE_NOTE_MAX_MS + 1500);
    vi.advanceTimersByTime(250);
    expect(h.latest().phase).toBe('review');
    expect(h.latest().durationMs).toBe(VOICE_NOTE_MAX_MS);
    expect(h.latest().notice).toContain('two-minute limit');
    expect(h.mic.track.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.dispose();
  });

  it('discards oversized audio without keeping the chunks or microphone', async () => {
    const h = harness();
    await h.controller.start();
    h.recorder.ondataavailable?.({ data: new Blob([new Uint8Array(VOICE_NOTE_MAX_BYTES + 1)]) });
    expect(h.latest().phase).toBe('error');
    expect(h.latest().error).toContain('10 MB');
    expect(h.latest().file).toBeUndefined();
    expect(h.mic.track.stop).toHaveBeenCalledTimes(1);
    expect(h.recorder.ondataavailable).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    h.controller.dispose();
  });

  it('releases tracks when constructing the recorder fails and allows retry', async () => {
    const h = harness();
    h.environment.create.mockImplementationOnce(() => { throw new Error('Codec unavailable'); });
    await h.controller.start();
    expect(h.latest().phase).toBe('error');
    expect(h.latest().error).toContain('Codec unavailable');
    expect(h.mic.track.stop).toHaveBeenCalledTimes(1);
    const next = microphone();
    h.environment.capture.mockResolvedValueOnce(next.stream);
    await h.controller.start();
    expect(h.latest().phase).toBe('recording');
    h.controller.dispose();
    expect(next.track.stop).toHaveBeenCalledTimes(1);
  });

  it('fails cleanly when the microphone disappears, without touching a call microphone', async () => {
    const h = harness();
    const callMicrophone = microphone();
    await h.controller.start();
    h.mic.track.dispatchEvent(new Event('ended'));
    expect(h.latest().error).toContain('disconnected');
    expect(h.mic.track.stop).toHaveBeenCalledTimes(1);
    expect(callMicrophone.track.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    h.controller.dispose();
  });

  it('cancels an active recording and suppresses final recorder callbacks', async () => {
    const h = harness();
    await h.controller.start();
    const callback = h.recorder.ondataavailable;
    h.controller.dispose();
    const before = h.states.length;
    callback?.({ data: new Blob(['late frame']) });
    expect(h.states).toHaveLength(before);
    expect(h.mic.track.stop).toHaveBeenCalledTimes(1);
    expect(h.recorder.onstop).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports denial and unsupported recording without acquiring any stream', async () => {
    const denied = harness();
    denied.environment.permission.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await denied.controller.start();
    expect(denied.latest().error).toContain('Microphone access was denied');
    expect(denied.environment.capture).not.toHaveBeenCalled();
    denied.controller.dispose();
    expect(voiceNoteMimeType(undefined)).toBeUndefined();
    expect(voiceNoteMimeType({ isTypeSupported: () => false })).toBeUndefined();
    expect(voiceNoteMimeType({ isTypeSupported: (type) => type === 'audio/mp4' })).toBe('audio/mp4');
    expect(voiceNoteTime(119_900)).toBe('1:59');
    expect(voiceNoteTime(-1)).toBe('0:00');
  });
});
