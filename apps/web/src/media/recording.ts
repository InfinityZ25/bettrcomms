import type {
  MediaSourceKind,
  RecordingFile,
  RecordingResult,
  RecordingTrackManifest,
} from './types';
import { invoke } from '@tauri-apps/api/core';
import { nativeScreenSessionForTrack } from './nativeCaptureRegistry';

export interface RecordableTrack {
  peerId: string;
  source: MediaSourceKind;
  track: MediaStreamTrack;
}

interface ActiveRecorder {
  segmentId: string;
  descriptor: RecordableTrack;
  recorder?: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  error?: string;
  endedAt?: number;
  endedReason?: RecordingTrackManifest['endedReason'];
  onTrackEnded?: () => void;
  native?: {
    recordingId: Promise<string | null>;
    stop?: Promise<void>;
    blob?: Blob;
    startedDelayMs?: number;
    durationMs?: number;
  };
}

export interface TrackRecordingOptions {
  /** Hard cap for chunks retained in memory across the session. Defaults to 512 MiB. */
  maxBytes?: number;
  /** Screen-share video bitrate. Defaults to 20 Mbps. */
  screenVideoBitsPerSecond?: number;
  /** Camera video bitrate. Defaults to 8 Mbps. */
  cameraVideoBitsPerSecond?: number;
  /** Microphone and system-audio bitrate. Defaults to 256 kbps. */
  audioBitsPerSecond?: number;
  onAutoStop?: (result: RecordingResult, reason: 'size-limit') => void;
  onError?: (error: Error, track?: RecordableTrack) => void;
}

export class TrackRecordingSession {
  readonly id = crypto.randomUUID();
  private readonly epoch = performance.now();
  private readonly wallClock = new Date();
  private active: ActiveRecorder[] = [];
  private stopped = false;
  private stopPromise?: Promise<RecordingResult>;
  private retainedBytes = 0;
  private readonly maxBytes: number;
  private readonly screenVideoBitsPerSecond: number;
  private readonly cameraVideoBitsPerSecond: number;
  private readonly audioBitsPerSecond: number;

  constructor(private readonly options: TrackRecordingOptions = {}) {
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    if (!Number.isFinite(this.maxBytes) || this.maxBytes < 1)
      throw new RangeError('maxBytes must be positive');
    this.screenVideoBitsPerSecond = validBitrate(
      'screenVideoBitsPerSecond',
      options.screenVideoBitsPerSecond ?? 20_000_000,
      250_000,
      100_000_000,
    );
    this.cameraVideoBitsPerSecond = validBitrate(
      'cameraVideoBitsPerSecond',
      options.cameraVideoBitsPerSecond ?? 8_000_000,
      250_000,
      100_000_000,
    );
    this.audioBitsPerSecond = validBitrate(
      'audioBitsPerSecond',
      options.audioBitsPerSecond ?? 256_000,
      16_000,
      1_000_000,
    );
  }

  start(tracks: RecordableTrack[], mimeTypes: string[] = []): void {
    if (this.active.length || this.stopped)
      throw new Error('Recording session has already been used');
    this.active = [];
    for (const descriptor of tracks) this.addTrack(descriptor, mimeTypes);
  }

  addTrack(descriptor: RecordableTrack, mimeTypes: string[] = []): void {
    if (this.stopped)
      throw new Error('Cannot add a track to a stopped recording');
    if (
      this.active.some(
        (active) => active.descriptor.track.id === descriptor.track.id && active.endedAt === undefined,
      )
    )
      return;
    const active: ActiveRecorder = {
      segmentId: this.active.some(item => item.descriptor.track.id === descriptor.track.id)
        ? crypto.randomUUID() : descriptor.track.id,
      descriptor,
      chunks: [],
      startedAt: performance.now(),
    };
    this.active.push(active);
    const nativeSessionId =
      descriptor.source === 'screen'
        ? nativeScreenSessionForTrack(descriptor.track)
        : undefined;
    if (nativeSessionId) {
      active.native = {
        recordingId: invoke<{ recordingId: string }>(
          'native_screen_recording_start',
          { sessionId: nativeSessionId },
        )
          .then(({ recordingId }) => recordingId)
          .catch((error) => {
            active.error =
              error instanceof Error ? error.message : String(error);
            active.endedReason = 'recorder-error';
            this.options.onError?.(new Error(active.error), descriptor);
            return null;
          }),
      };
      active.onTrackEnded = () => {
        active.endedReason ??= 'track-ended';
        active.endedAt ??= performance.now();
        void this.finishNative(active);
      };
      descriptor.track.addEventListener('ended', active.onTrackEnded, {
        once: true,
      });
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      active.error = 'MediaRecorder is unavailable in this browser';
      active.endedReason = 'recorder-error';
      this.options.onError?.(new Error(active.error), descriptor);
      return;
    }
    const mimeType = mimeTypes.find((candidate) =>
      MediaRecorder.isTypeSupported(candidate),
    );
    try {
      const bitrate =
        descriptor.track.kind === 'video'
          ? descriptor.source === 'screen'
            ? { videoBitsPerSecond: this.screenVideoBitsPerSecond }
            : { videoBitsPerSecond: this.cameraVideoBitsPerSecond }
          : { audioBitsPerSecond: this.audioBitsPerSecond };
      const recorder = new MediaRecorder(new MediaStream([descriptor.track]), {
        ...(mimeType ? { mimeType } : {}),
        ...bitrate,
      });
      active.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        if (this.retainedBytes + event.data.size > this.maxBytes) {
          active.error = `Recording memory limit of ${this.maxBytes} bytes reached; final chunk was not retained`;
          active.endedReason = 'size-limit';
          void this.autoStop();
          return;
        }
        active.chunks.push(event.data);
        this.retainedBytes += event.data.size;
      };
      recorder.onerror = (event) => {
        active.error = (event as ErrorEvent).message || 'MediaRecorder failed';
        active.endedReason = 'recorder-error';
        this.options.onError?.(new Error(active.error), descriptor);
      };
      recorder.onstop = () => {
        active.endedAt ??= performance.now();
      };
      active.onTrackEnded = () => {
        active.endedReason ??= 'track-ended';
        active.endedAt ??= performance.now();
        if (recorder.state !== 'inactive') recorder.stop();
      };
      descriptor.track.addEventListener('ended', active.onTrackEnded, {
        once: true,
      });
      recorder.start(1000);
    } catch (error) {
      active.error = error instanceof Error ? error.message : String(error);
      active.endedReason = 'recorder-error';
      this.options.onError?.(
        error instanceof Error ? error : new Error(active.error),
        descriptor,
      );
    }
  }

  removeTrack(trackId: string): void {
    const active = this.active.find(
      (item) => item.descriptor.track.id === trackId && item.endedAt === undefined,
    );
    if (!active || active.endedAt !== undefined) return;
    active.endedReason = 'track-ended';
    active.endedAt = performance.now();
    if (active.onTrackEnded) {
      active.descriptor.track.removeEventListener('ended', active.onTrackEnded);
      active.onTrackEnded = undefined;
    }
    if (active.native) void this.finishNative(active);
    if (active.recorder?.state !== 'inactive') active.recorder?.stop();
  }

  async stop(): Promise<RecordingResult> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.finish();
    return this.stopPromise;
  }

  private async finish(): Promise<RecordingResult> {
    this.stopped = true;
    const stopRequestedAt = performance.now();
    for (const active of this.active) {
      if (active.onTrackEnded) {
        active.descriptor.track.removeEventListener(
          'ended',
          active.onTrackEnded,
        );
        active.onTrackEnded = undefined;
      }
    }
    await Promise.all(
      this.active.map(
        (active) =>
          new Promise<void>((resolve) => {
            if (active.native) {
              active.endedReason ??= 'session-stopped';
              active.endedAt ??= stopRequestedAt;
              void this.finishNative(active).then(resolve);
              return;
            }
            const { recorder } = active;
            if (!recorder || recorder.state === 'inactive') return resolve();
            recorder.addEventListener('stop', () => resolve(), { once: true });
            active.endedReason ??= 'session-stopped';
            active.endedAt ??= stopRequestedAt;
            recorder.stop();
          }),
      ),
    );
    const stoppedAt = performance.now();
    const files: RecordingFile[] = [];
    const tracks: RecordingTrackManifest[] = this.active.map(
      (active, index) => {
        const mimeType =
          active.native?.blob?.type ||
          active.recorder?.mimeType ||
          active.chunks[0]?.type ||
          'application/octet-stream';
        const extension = mimeType.includes('mp4')
          ? 'mp4'
          : mimeType.includes('ogg')
            ? 'ogg'
            : 'webm';
        const fileName = `${String(index + 1).padStart(2, '0')}-${safe(active.descriptor.peerId)}-${active.descriptor.source}.${extension}`;
        const blob =
          active.native?.blob ?? new Blob(active.chunks, { type: mimeType });
        if (blob.size) files.push({ name: fileName, blob });
        return {
          id: active.segmentId,
          peerId: active.descriptor.peerId,
          source: active.descriptor.source,
          mediaKind: active.descriptor.track.kind as 'audio' | 'video',
          mimeType,
          fileName,
          startedOffsetMs: Math.round(
            active.startedAt -
              this.epoch +
              (active.native?.startedDelayMs ?? 0),
          ),
          durationMs:
            active.native?.durationMs ??
            Math.round((active.endedAt ?? stoppedAt) - active.startedAt),
          bytes: blob.size,
          status: active.error
            ? active.recorder || active.native
              ? 'error'
              : 'unsupported'
            : blob.size
              ? 'complete'
              : 'empty',
          endedReason: active.endedReason ?? 'session-stopped',
          ...(active.error ? { error: active.error } : {}),
        };
      },
    );
    const manifest = {
      version: 1 as const,
      recordingId: this.id,
      startedAt: this.wallClock.toISOString(),
      stoppedAt: new Date(
        this.wallClock.getTime() + stoppedAt - this.epoch,
      ).toISOString(),
      tracks,
      replay: {
        status: 'unsupported' as const,
        reason:
          'Bounded instant replay is not implemented by the browser media engine.',
      },
    };
    files.push({
      name: 'manifest.json',
      blob: new Blob([JSON.stringify(manifest, null, 2)], {
        type: 'application/json',
      }),
    });
    return { manifest, files };
  }

  private async autoStop(): Promise<void> {
    if (this.stopPromise) return;
    const result = await this.stop();
    this.options.onAutoStop?.(result, 'size-limit');
  }

  private finishNative(active: ActiveRecorder): Promise<void> {
    if (!active.native) return Promise.resolve();
    if (active.native.stop) return active.native.stop;
    active.native.stop = (async () => {
      const recordingId = await active.native!.recordingId;
      if (!recordingId) return;
      let assetId: string | undefined;
      try {
        const asset = await invoke<{
          assetId: string;
          mimeType: string;
          sizeBytes: number;
          startedDelayMs: number;
          durationMs: number;
        }>('native_screen_recording_stop', { recordingId });
        assetId = asset.assetId;
        if (
          !Number.isSafeInteger(asset.sizeBytes) ||
          asset.sizeBytes < 1 ||
          asset.sizeBytes > 512 * 1024 * 1024
        ) {
          throw new Error('Native recording returned an invalid asset size');
        }
        if (this.retainedBytes + asset.sizeBytes > this.maxBytes) {
          throw new Error(
            `Native screen recording of ${asset.sizeBytes} bytes exceeds the remaining recording memory limit`,
          );
        }
        this.retainedBytes += asset.sizeBytes;
        let reserved = true;
        const parts: ArrayBuffer[] = [];
        let offset = 0;
        try {
          while (offset < asset.sizeBytes) {
            const payload = await invoke<ArrayBuffer>(
              'native_screen_recording_read',
              { assetId, offset, maxBytes: 256 * 1024 },
            );
            const bytes = new Uint8Array(payload);
            if (!bytes.length || offset + bytes.length > asset.sizeBytes) {
              throw new Error(
                'Native recording returned an invalid asset chunk',
              );
            }
            const part = new ArrayBuffer(bytes.length);
            new Uint8Array(part).set(bytes);
            parts.push(part);
            offset += bytes.length;
          }
          active.native!.blob = new Blob(parts, { type: asset.mimeType });
          active.native!.startedDelayMs = asset.startedDelayMs;
          active.native!.durationMs = asset.durationMs;
          reserved = false;
        } finally {
          if (reserved) this.retainedBytes -= asset.sizeBytes;
        }
      } catch (error) {
        active.error = error instanceof Error ? error.message : String(error);
        active.endedReason = 'recorder-error';
        this.options.onError?.(new Error(active.error), active.descriptor);
      } finally {
        if (assetId) {
          await invoke('native_screen_recording_release', { assetId }).catch(
            () => undefined,
          );
        }
      }
    })();
    return active.native.stop;
  }
}

export function downloadRecording(result: RecordingResult): void {
  for (const file of result.files) {
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

function safe(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 80);
}

function validBitrate(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
