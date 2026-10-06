import { allowDesktopCapture } from '@/media/permissions';
import { readStored } from '@/lib/storage';
import { deviceError } from '@/features/settings/devices/deviceHelpers';

export const VOICE_NOTE_MAX_MS = 120_000;
export const VOICE_NOTE_MAX_BYTES = 10 * 1024 * 1024;
const mimeTypes = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];

export function voiceNoteMimeType(recorder: Pick<typeof MediaRecorder, 'isTypeSupported'> | undefined) {
  return recorder ? mimeTypes.find((mime) => recorder.isTypeSupported(mime)) : undefined;
}

export function voiceNoteTime(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export type VoiceNoteState = {
  phase: 'idle' | 'requesting' | 'recording' | 'stopping' | 'review' | 'error';
  durationMs: number;
  error?: string;
  notice?: string;
  file?: File;
};

type RecorderEnvironment = {
  permission: () => Promise<void>;
  capture: () => Promise<MediaStream>;
  create: (stream: MediaStream, mime: string) => MediaRecorder;
  mime: () => string | undefined;
  now: () => number;
};

const browserEnvironment: RecorderEnvironment = {
  permission: () => allowDesktopCapture('microphone'),
  capture: () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone recording is unavailable in this app or browser.');
    const input = readStored('bc-input');
    return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(input ? { deviceId: { ideal: input } } : {}) }, video: false });
  },
  create: (stream, mimeType) => new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 }),
  mime: () => voiceNoteMimeType(typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder),
  now: () => performance.now(),
};

/** Owns only the tracks acquired for this note, independently of call/PTT capture. */
export class VoiceNoteRecorder {
  private generation = 0;
  private disposed = false;
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private bytes = 0;
  private startedAt = 0;
  private durationMs = 0;
  private interval?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private trackEnded = () => this.fail('The microphone disconnected. Please record the note again.');
  private phase: VoiceNoteState['phase'] = 'idle';

  constructor(private changed: (state: VoiceNoteState) => void, private environment: RecorderEnvironment = browserEnvironment) {}

  private emit(state: VoiceNoteState) {
    this.phase = state.phase;
    if (!this.disposed) this.changed(state);
  }

  async start() {
    if (this.disposed || ['requesting', 'recording', 'stopping'].includes(this.phase)) return;
    this.cancel();
    const generation = this.generation;
    const stale = () => this.disposed || generation !== this.generation;
    this.emit({ phase: 'requesting', durationMs: 0 });
    try {
      const mime = this.environment.mime();
      if (!mime) throw new Error('Voice recording is not supported in this app or browser. You can attach an audio file instead.');
      await this.environment.permission();
      if (stale()) return;
      const stream = await this.environment.capture();
      if (stale()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) throw new Error('The microphone did not provide an audio track.');
      const recorder = this.environment.create(stream, mime);
      this.recorder = recorder;
      this.chunks = [];
      this.bytes = 0;
      this.durationMs = 0;
      this.startedAt = this.environment.now();
      recorder.ondataavailable = (event) => {
        if (stale() || !event.data.size) return;
        if (this.bytes + event.data.size > VOICE_NOTE_MAX_BYTES) { this.fail('This recording exceeded 10 MB. Please record a shorter note.'); return; }
        this.bytes += event.data.size;
        this.chunks.push(event.data);
      };
      recorder.onerror = () => { if (!stale()) this.fail('Recording failed. Check your microphone and try again.'); };
      recorder.onstop = () => {
        if (stale()) return;
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
        this.releaseCapture();
        const type = recorder.mimeType || mime;
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        this.bytes = 0;
        this.recorder = undefined;
        if (!blob.size || this.durationMs < 250) { this.emit({ phase: 'error', durationMs: 0, error: 'The recording was too short. Record for at least a moment and try again.' }); return; }
        const extension = type.startsWith('audio/mp4') ? 'm4a' : 'webm';
        const file = new File([blob], `voice-note-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, { type });
        this.emit({ phase: 'review', durationMs: this.durationMs, file, notice: this.durationMs >= VOICE_NOTE_MAX_MS ? 'The two-minute limit was reached. Your note is ready to review.' : undefined });
      };
      stream.getTracks().forEach((track) => track.addEventListener('ended', this.trackEnded));
      recorder.start(250);
      this.emit({ phase: 'recording', durationMs: 0 });
      this.interval = setInterval(() => {
        if (stale() || this.phase !== 'recording') return;
        const durationMs = this.elapsed();
        if (durationMs >= VOICE_NOTE_MAX_MS) this.stop();
        else this.emit({ phase: 'recording', durationMs });
      }, 250);
      this.deadline = setTimeout(() => this.stop(), VOICE_NOTE_MAX_MS);
    } catch (error) {
      if (!stale()) this.fail(deviceError(error, 'microphone'));
    }
  }

  stop() {
    if (this.phase !== 'recording' || !this.recorder) return;
    this.durationMs = this.elapsed();
    this.clearTimers();
    this.emit({ phase: 'stopping', durationMs: this.durationMs });
    try { this.recorder.stop(); } catch (error) { this.fail(deviceError(error)); }
    this.releaseCapture();
  }

  cancel() {
    ++this.generation;
    this.clearTimers();
    const recorder = this.recorder;
    this.recorder = undefined;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* A device can stop before cancellation. */ } }
    }
    this.releaseCapture();
    this.chunks = [];
    this.bytes = 0;
    this.durationMs = 0;
    this.emit({ phase: 'idle', durationMs: 0 });
  }

  dispose() { this.disposed = true; this.cancel(); }

  private elapsed() { return Math.min(VOICE_NOTE_MAX_MS, Math.max(0, Math.round(this.environment.now() - this.startedAt))); }
  private clearTimers() { clearInterval(this.interval); clearTimeout(this.deadline); this.interval = undefined; this.deadline = undefined; }
  private releaseCapture() {
    this.clearTimers();
    const stream = this.stream;
    this.stream = undefined;
    stream?.getTracks().forEach((track) => { track.removeEventListener('ended', this.trackEnded); track.stop(); });
  }
  private fail(error: string) { this.cancel(); this.emit({ phase: 'error', durationMs: 0, error }); }
}
