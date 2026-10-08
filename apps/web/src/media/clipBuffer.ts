import type { RecordableTrack } from './recording';
import type { MediaSourceKind } from './types';

export interface ClipSegment {
  id: string;
  peerId: string;
  source: MediaSourceKind;
  startMs: number;
  endMs: number;
  blob: Blob;
}
export interface ClipWindow {
  segments: readonly ClipSegment[];
  startMs: number;
  endMs: number;
}
interface ActiveSegment {
  descriptor: RecordableTrack;
  recorder: MediaRecorder;
  chunks: Blob[];
  startMs: number;
  bytes: number;
  endMs?: number;
  finish: Promise<void>;
  ended: () => void;
  stopping: boolean;
}
export interface ClipBufferOptions {
  windowMs?: number;
  segmentMs?: number;
  maxBytes?: number;
  onError?: (error: Error) => void;
}

/** Each segment has its own container header. Arbitrary MediaRecorder chunks
 * cannot be cut out of a recording and expected to remain decodable. The
 * window keeps microphone, camera, screen and system audio as separate assets. */
export class ClipBuffer {
  private active = new Map<string, ActiveSegment>();
  private segments: ClipSegment[] = [];
  private pending = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private origin = performance.now();
  private bytes = 0;
  private readonly windowMs: number;
  private readonly segmentMs: number;
  private readonly maxBytes: number;

  constructor(private readonly options: ClipBufferOptions = {}) {
    this.windowMs = options.windowMs ?? 90_000;
    this.segmentMs = options.segmentMs ?? 5_000;
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    if (
      ![this.windowMs, this.segmentMs, this.maxBytes].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    )
      throw new RangeError('Clip buffer limits must be positive');
    this.timer = setInterval(() => this.rotate(), this.segmentMs);
  }

  get retainedBytes() {
    return this.bytes;
  }
  get durationMs() {
    const now = this.now();
    const starts = [
      ...this.segments.map((item) => item.startMs),
      ...[...this.active.values()].map((item) => item.startMs),
    ];
    return starts.length
      ? Math.min(this.windowMs, now - Math.min(...starts))
      : 0;
  }

  reconcile(tracks: readonly RecordableTrack[]) {
    if (this.disposed) return;
    const current = new Map(
      tracks
        .filter((item) => item.track.readyState === 'live')
        .map((item) => [item.track.id, item]),
    );
    for (const [id, item] of this.active)
      if (!current.has(id)) this.stopSegment(id, item);
    for (const [id, descriptor] of current)
      if (!this.active.has(id)) this.begin(id, descriptor);
    this.evict(this.now());
  }

  async snapshot(): Promise<ClipWindow> {
    if (this.disposed) throw new Error('The clip buffer has stopped');
    const endMs = this.now();
    this.rotate();
    await Promise.all([...this.pending]);
    if (this.disposed)
      throw new Error('The clip buffer stopped while preparing your clip');
    const selected = this.segments.filter(
      (item) => item.endMs > endMs - this.windowMs && item.startMs < endMs,
    );
    if (!selected.length)
      throw new Error('Let the clip buffer capture a few seconds first');
    return {
      segments: [...selected],
      startMs: Math.max(
        endMs - this.windowMs,
        Math.min(...selected.map((item) => item.startMs)),
      ),
      endMs,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    for (const [id, item] of this.active) this.stopSegment(id, item);
    await Promise.all([...this.pending]);
    this.segments = [];
    this.bytes = 0;
  }

  private now() {
    return performance.now() - this.origin;
  }
  private rotate() {
    if (this.disposed) return;
    const current = [...this.active.entries()];
    for (const [id, item] of current) {
      this.stopSegment(id, item);
      if (item.descriptor.track.readyState === 'live')
        this.begin(id, item.descriptor);
    }
    this.evict(this.now());
  }
  private begin(id: string, descriptor: RecordableTrack) {
    if (this.disposed) return;
    let failedRecorder: MediaRecorder | undefined;
    try {
      // Borrow the engine-owned track. A clone has an independent enabled flag
      // and would keep recording briefly after mute or push-to-talk release.
      const candidates =
        descriptor.track.kind === 'video'
          ? ['video/webm;codecs=vp8', 'video/webm', 'video/mp4']
          : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      const mimeType = candidates.find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(new MediaStream([descriptor.track]), {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 3_000_000,
        audioBitsPerSecond: 128_000,
      });
      failedRecorder = recorder;
      let complete!: () => void;
      const finish = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const item: ActiveSegment = {
        descriptor,
        recorder,
        chunks: [],
        startMs: this.now(),
        bytes: 0,
        finish,
        stopping: false,
        ended: () => this.stopSegment(id, item),
      };
      let released = false;
      const release = (retain: boolean) => {
        if (released) return;
        released = true;
        descriptor.track.removeEventListener('ended', item.ended);
        if (this.active.get(id) === item) this.active.delete(id);
        this.bytes -= item.bytes;
        const endMs = item.endMs ?? this.now();
        if (
          retain &&
          !this.disposed &&
          item.bytes &&
          endMs - item.startMs > 1
        ) {
          const blob = new Blob(item.chunks, {
            type: recorder.mimeType || item.chunks[0]?.type,
          });
          this.segments.push({
            id: crypto.randomUUID(),
            peerId: descriptor.peerId,
            source: descriptor.source,
            startMs: item.startMs,
            endMs,
            blob,
          });
          this.bytes += blob.size;
          this.evict(this.now());
        }
        item.chunks = [];
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
        complete();
      };
      recorder.ondataavailable = (event) => {
        if (
          !event.data.size ||
          this.disposed ||
          (item.endMs !== undefined && item.endMs - item.startMs <= 1)
        )
          return;
        item.chunks.push(event.data);
        item.bytes += event.data.size;
        this.bytes += event.data.size;
        this.evict(this.now());
        if (this.bytes > this.maxBytes) {
          this.options.onError?.(
            new Error('Clip memory limit reached. The local buffer stopped.'),
          );
          void this.dispose();
        }
      };
      recorder.onstop = () => release(true);
      recorder.onerror = () => {
        this.options.onError?.(
          new Error(`Could not buffer ${descriptor.source}`),
        );
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            release(false);
          }
        } else release(false);
      };
      descriptor.track.addEventListener('ended', item.ended, { once: true });
      this.active.set(id, item);
      recorder.start(1_000);
    } catch (error) {
      if (failedRecorder?.state === 'inactive')
        failedRecorder.onstop?.call(failedRecorder, new Event('stop'));
      this.options.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      void this.dispose();
    }
  }
  private stopSegment(id: string, item: ActiveSegment) {
    if (item.stopping) return;
    item.stopping = true;
    item.endMs = this.now();
    if (this.active.get(id) === item) this.active.delete(id);
    this.pending.add(item.finish);
    void item.finish.finally(() => this.pending.delete(item.finish));
    // Even an inactive recorder can still owe its final dataavailable/stop.
    if (item.recorder.state !== 'inactive') {
      try {
        item.recorder.stop();
      } catch {
        item.recorder.onstop?.call(item.recorder, new Event('stop'));
      }
    }
  }
  private evict(now: number) {
    this.segments.sort((a, b) => a.endMs - b.endMs);
    while (
      this.segments.length &&
      (this.segments[0]!.endMs <= now - this.windowMs ||
        this.bytes > this.maxBytes)
    )
      this.bytes -= this.segments.shift()!.blob.size;
  }
}

export function clampClipRange(
  window: ClipWindow,
  startMs: number,
  endMs: number,
) {
  const start = Math.max(window.startMs, Math.min(startMs, window.endMs - 1));
  return {
    startMs: start,
    endMs: Math.max(start + 1, Math.min(window.endMs, start + 60_000, endMs)),
  };
}
