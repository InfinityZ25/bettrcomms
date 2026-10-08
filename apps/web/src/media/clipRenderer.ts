import type { ClipSegment, ClipWindow } from './clipBuffer';
import { clampClipRange } from './clipBuffer';

export interface ClipRenderOptions {
  window: ClipWindow;
  startMs: number;
  endMs: number;
  videoKey?: string;
  audioKeys: readonly string[];
  title: string;
  signal: AbortSignal;
  onProgress?: (value: number) => void;
  preview?: boolean;
  canvas?: HTMLCanvasElement;
}
export const clipTrackKey = (segment: Pick<ClipSegment, 'peerId' | 'source'>) =>
  `${segment.peerId}:${segment.source}`;

async function waitForMedia(
  promise: Promise<unknown>,
  signal: AbortSignal,
  message: string,
) {
  signal.throwIfAborted();
  let cancel: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        cancel = () =>
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', cancel, { once: true });
        timeout = setTimeout(() => reject(new Error(message)), 10_000);
        if (signal.aborted) cancel();
      }),
    ]);
    signal.throwIfAborted();
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel);
    clearTimeout(timeout);
  }
}

const playMedia = (element: HTMLMediaElement, signal: AbortSignal) =>
  waitForMedia(element.play(), signal, 'Clip playback could not start');

function waitMedia(
  element: HTMLMediaElement,
  event: 'loadedmetadata' | 'seeked',
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error('A clip segment could not be decoded')),
      10_000,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      element.removeEventListener(event, ready);
      element.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (error?: unknown) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const ready = () => finish();
    const failed = () =>
      finish(new Error('This browser cannot decode a clip segment'));
    const aborted = () =>
      finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    element.addEventListener(event, ready, { once: true });
    element.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Decode the independent source assets at their recorded offsets. Playback
 * gain in the live call never enters this graph. Mixing is an explicit export
 * operation; the retained source tracks remain independent and untouched. */
export async function renderClip(
  options: ClipRenderOptions,
): Promise<Blob | null> {
  const { window, videoKey, audioKeys } = options;
  options.signal.throwIfAborted();
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  const abortLifetime = () => lifetime.abort(options.signal.reason);
  const { startMs, endMs } = clampClipRange(
    window,
    options.startMs,
    options.endMs,
  );
  const canvas = options.canvas ?? document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const drawing = canvas.getContext('2d', { alpha: false });
  if (!drawing) throw new Error('This browser cannot render video clips');
  let context: AudioContext | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  const players = new Map<
    string,
    {
      element: HTMLMediaElement;
      node?: MediaElementAudioSourceNode;
      current?: ClipSegment;
      url?: string;
    }
  >();
  const tracks = new Map<string, ClipSegment[]>();
  const keys = [...new Set([...(videoKey ? [videoKey] : []), ...audioKeys])];
  for (const key of keys)
    tracks.set(
      key,
      window.segments
        .filter((item) => clipTrackKey(item) === key)
        .sort((a, b) => a.startMs - b.startMs),
    );
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let completeRecording: Promise<Blob> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let aborted: (() => void) | undefined;
  let runAbort: (() => void) | undefined;
  let recordedBytes = 0;
  let pendingUpdate: Promise<void> | undefined;
  let origin: number | undefined;
  const clipTime = () =>
    origin === undefined
      ? startMs
      : Math.min(endMs, startMs + performance.now() - origin);

  async function synchronize() {
    await Promise.all(
      keys.map(async (key) => {
        signal.throwIfAborted();
        let player = players.get(key);
        if (!player) {
          const element = document.createElement(
            key === videoKey ? 'video' : 'audio',
          );
          element.preload = 'auto';
          element.setAttribute('playsinline', '');
          element.muted = key === videoKey;
          player = { element };
          if (key !== videoKey) {
            player.node = context!.createMediaElementSource(element);
            player.node.connect(destination!);
            if (options.preview) player.node.connect(context!.destination);
          }
          players.set(key, player);
        }
        // Decode latency must not become a permanent offset between sources.
        // Recheck the shared clock after loading/seeking, including when a slow
        // decoder has already crossed into a later segment.
        while (!signal.aborted) {
          const timeMs = clipTime();
          const segment = tracks
            .get(key)
            ?.find((item) => item.startMs <= timeMs && item.endMs > timeMs);
          if (!segment) {
            player.element.pause();
            player.current = undefined;
            return;
          }
          const changed = player.current?.id !== segment.id;
          if (changed) {
            player.element.pause();
            if (player.url) URL.revokeObjectURL(player.url);
            player.url = URL.createObjectURL(segment.blob);
            player.current = segment;
            const loaded = waitMedia(player.element, 'loadedmetadata', signal);
            player.element.src = player.url;
            player.element.load();
            await loaded;
            signal.throwIfAborted();
          }
          const currentTime = clipTime();
          if (currentTime >= segment.endMs) continue;
          const offset = Math.max(0, (currentTime - segment.startMs) / 1000);
          const target = Number.isFinite(player.element.duration)
            ? Math.min(offset, Math.max(0, player.element.duration - 0.01))
            : offset;
          if (
            Math.abs(player.element.currentTime - target) >
            (changed ? 0.02 : 0.1)
          ) {
            const seek = waitMedia(player.element, 'seeked', signal);
            player.element.currentTime = target;
            await seek;
            signal.throwIfAborted();
            if (clipTime() >= segment.endMs) continue;
          }
          // Initial preparation stays paused until every source is ready and
          // the export recorder exists. Playback calls then share one origin.
          if (origin !== undefined && (changed || player.element.paused))
            await playMedia(player.element, signal);
          return;
        }
        signal.throwIfAborted();
      }),
    );
  }
  function draw() {
    drawing!.fillStyle = '#101419';
    drawing!.fillRect(0, 0, canvas.width, canvas.height);
    const video = videoKey ? players.get(videoKey) : undefined;
    if (
      video?.current &&
      video.element instanceof HTMLVideoElement &&
      video.element.readyState >= 2
    ) {
      const scale = Math.min(
        canvas.width / video.element.videoWidth,
        canvas.height / video.element.videoHeight,
      );
      const width = video.element.videoWidth * scale;
      const height = video.element.videoHeight * scale;
      drawing!.drawImage(
        video.element,
        (canvas.width - width) / 2,
        (canvas.height - height) / 2,
        width,
        height,
      );
    } else {
      drawing!.fillStyle = '#d8e6f5';
      drawing!.textAlign = 'center';
      drawing!.font = '500 32px system-ui';
      drawing!.fillText(
        options.title.slice(0, 64) || 'Bettercomms clip',
        canvas.width / 2,
        canvas.height / 2,
        canvas.width - 100,
      );
      drawing!.font = '18px system-ui';
      drawing!.fillStyle = '#8c9aab';
      drawing!.fillText('Audio clip', canvas.width / 2, canvas.height / 2 + 42);
    }
  }
  try {
    options.signal.addEventListener('abort', abortLifetime, { once: true });
    if (options.signal.aborted) abortLifetime();
    signal.throwIfAborted();
    context = new AudioContext();
    destination = context.createMediaStreamDestination();
    await waitForMedia(context.resume(), signal, 'Clip audio could not start');
    signal.throwIfAborted();
    pendingUpdate = synchronize();
    await pendingUpdate;
    draw();
    if (!options.preview) {
      if (typeof canvas.captureStream !== 'function')
        throw new Error('Video clip export is unavailable in this browser');
      stream = new MediaStream([
        ...canvas.captureStream(30).getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);
      const mimeType = [
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 5_000_000,
        audioBitsPerSecond: 128_000,
      });
      const chunks: Blob[] = [];
      completeRecording = new Promise<Blob>((resolve, reject) => {
        recorder!.ondataavailable = (event) => {
          if (event.data.size) {
            recordedBytes += event.data.size;
            chunks.push(event.data);
          }
          if (recordedBytes > 100 * 1024 * 1024) {
            reject(new Error('The clip exceeded its 100 MiB export limit'));
            runAbort?.();
          }
        };
        recorder!.onerror = () => {
          reject(new Error('The clip could not be encoded'));
          runAbort?.();
        };
        recorder!.onstop = () =>
          resolve(
            new Blob(chunks, { type: recorder!.mimeType || chunks[0]?.type }),
          );
      });
      // Observe early encoding errors while the playback loop is still running.
      void completeRecording.catch(() => {});
      recorder.start(1000);
    }
    origin = performance.now();
    await Promise.all(
      [...players.values()]
        .filter((player) => player.current)
        .map((player) => playMedia(player.element, signal)),
    );
    signal.throwIfAborted();
    if (clipTime() >= endMs)
      throw new Error(
        'Clip playback could not start before the selected moment ended',
      );
    await new Promise<void>((resolve, reject) => {
      let updating = false;
      const end = (error?: unknown) => {
        clearInterval(timer);
        signal.removeEventListener('abort', aborted!);
        if (error) reject(error);
        else resolve();
      };
      aborted = () =>
        end(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      runAbort = () => end(new Error('Clip encoding stopped'));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      timer = setInterval(() => {
        const elapsed = performance.now() - origin!;
        if (elapsed >= endMs - startMs) {
          end();
          return;
        }
        options.onProgress?.(Math.min(1, elapsed / (endMs - startMs)));
        draw();
        if (updating) return;
        updating = true;
        pendingUpdate = synchronize()
          .then(draw)
          .catch(end)
          .finally(() => {
            updating = false;
          });
      }, 33);
    });
    signal.throwIfAborted();
    if (recorder?.state !== 'inactive') recorder?.stop();
    let blob: Blob | null = null;
    if (completeRecording) {
      let finalAbort: (() => void) | undefined;
      let finalTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        blob = await Promise.race([
          completeRecording,
          new Promise<never>((_resolve, reject) => {
            finalAbort = () =>
              reject(
                signal.reason ?? new DOMException('Aborted', 'AbortError'),
              );
            signal.addEventListener('abort', finalAbort, { once: true });
            finalTimeout = setTimeout(
              () => reject(new Error('The clip encoder did not finish')),
              15_000,
            );
            if (signal.aborted) finalAbort();
          }),
        ]);
      } finally {
        if (finalAbort) signal.removeEventListener('abort', finalAbort);
        clearTimeout(finalTimeout);
      }
    }
    signal.throwIfAborted();
    options.onProgress?.(1);
    return blob;
  } finally {
    lifetime.abort();
    options.signal.removeEventListener('abort', abortLifetime);
    clearInterval(timer);
    if (aborted) signal.removeEventListener('abort', aborted);
    for (const player of players.values()) player.element.pause();
    await pendingUpdate?.catch(() => {});
    for (const player of players.values()) {
      player.element.pause();
      player.element.removeAttribute('src');
      player.element.load();
      player.node?.disconnect();
      if (player.url) URL.revokeObjectURL(player.url);
    }
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
    }
    for (const track of stream?.getTracks() ?? []) track.stop();
    for (const track of destination?.stream.getTracks() ?? []) track.stop();
    await context?.close();
  }
}
