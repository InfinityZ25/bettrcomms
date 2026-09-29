import { callIOSNative, iosNativeBinding } from '@/desktop/iosNativeBindings';
import { readDesktopBootReport } from '@/desktop/runtime';

export const META_GLASSES_CAMERA_ID = 'bettercomms:meta-glasses-camera';
export const hasMetaGlassesCamera = () =>
  readDesktopBootReport()?.platform === 'ios';

type MetaEvent =
  | { kind: 'frame'; jpeg: string; width: number; height: number }
  | { kind: 'error'; message: string }
  | { kind: 'stopped' | 'streaming' | 'starting' | 'connecting' | 'registered' | 'waitingForDevice' };

// Call video and the Settings preview may use the same SDK session together.
// Stopping one canvas must not disconnect the other's glasses stream.
let activeConsumers = 0;
const metaTracks = new WeakSet<MediaStreamTrack>();
export const isMetaGlassesTrack = (track: MediaStreamTrack | null) => !!track && metaTracks.has(track);

/** Convert native DAT frames into an ordinary call camera track on iOS. */
export async function startMetaGlassesCamera(signal?: AbortSignal): Promise<{
  track: MediaStreamTrack;
  dispose: () => void;
}> {
  signal?.throwIfAborted();
  if (!hasMetaGlassesCamera()) throw new Error('Meta glasses camera requires the iPhone app.');
  const canvas = document.createElement('canvas');
  if (typeof canvas.captureStream !== 'function') {
    throw new Error('This iPhone webview cannot publish the glasses camera.');
  }
  canvas.width = 360;
  canvas.height = 640;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a glasses camera preview.');
  const stream = canvas.captureStream(30);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('Could not create a glasses camera track.');
  let disposed = false;
  let ownsNative = false;
  let firstFrame = false;
  let resolveFirst!: () => void;
  let rejectFirst!: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  // Cancellation/native events can arrive before the binding promise settles.
  // Keep the rejection observed until the caller reaches `await ready`.
  void ready.catch(() => {});
  let timeout: number;
  const waitForFrame = (milliseconds: number) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => {
      rejectFirst(new Error('Glasses camera did not send video. In Meta AI, check Developer Mode and install the glasses developer component if shown.'));
    }, milliseconds);
  };
  waitForFrame(30_000);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(timeout);
    window.removeEventListener('bc-meta-camera', onMetaEvent);
    signal?.removeEventListener('abort', onAbort);
    track.stop();
    if (ownsNative && --activeConsumers === 0)
      void callIOSNative(iosNativeBinding.metaStop).catch(() => {});
  };
  const onAbort = () => {
    rejectFirst(new DOMException('Glasses camera connection cancelled.', 'AbortError'));
    dispose();
  };
  const onMetaEvent = (event: Event) => {
    if (disposed) return;
    const detail = (event as CustomEvent<MetaEvent>).detail;
    if (!detail) return;
    if (detail.kind === 'connecting') {
      // Registration switches to Meta AI; allow time to approve and return.
      waitForFrame(5 * 60_000);
      return;
    }
    if (detail.kind === 'registered' || detail.kind === 'starting') {
      // Camera permission may require a second Meta AI round trip.
      waitForFrame(2 * 60_000);
      return;
    }
    if (detail.kind === 'waitingForDevice') {
      waitForFrame(90_000);
      return;
    }
    if (detail.kind === 'streaming') {
      waitForFrame(30_000);
      return;
    }
    if (detail.kind === 'error') {
      rejectFirst(new Error(detail.message));
      if (firstFrame) {
        dispose();
        track.dispatchEvent(new Event('ended'));
      }
      return;
    }
    if (detail.kind === 'stopped') {
      if (!firstFrame) rejectFirst(new Error('Glasses camera stopped before video arrived.'));
      else {
        dispose();
        track.dispatchEvent(new Event('ended'));
      }
      return;
    }
    if (detail.kind !== 'frame') return;
    const image = new Image();
    image.onload = () => {
      if (disposed) return;
      if (canvas.width !== detail.width || canvas.height !== detail.height) {
        canvas.width = detail.width;
        canvas.height = detail.height;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (!firstFrame) {
        firstFrame = true;
        window.clearTimeout(timeout);
        resolveFirst();
      }
    };
    image.src = `data:image/jpeg;base64,${detail.jpeg}`;
  };
  window.addEventListener('bc-meta-camera', onMetaEvent);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) { onAbort(); await ready; }
    activeConsumers++;
    ownsNative = true;
    await callIOSNative(iosNativeBinding.metaStart);
    await ready;
    metaTracks.add(track);
    return { track, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** User-requested repair; never revoke registration as part of automatic retry. */
export async function reconnectMetaGlassesCamera(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!hasMetaGlassesCamera()) throw new Error('Reconnecting glasses requires the iPhone app.');
  if (activeConsumers) throw new Error('Turn off glasses video before reconnecting.');
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener('bc-meta-camera', listener);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(new DOMException('Reconnection cancelled.', 'AbortError')); };
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<MetaEvent>).detail;
      if (detail?.kind === 'registered') { cleanup(); resolve(); }
      else if (detail?.kind === 'error') { cleanup(); reject(new Error(detail.message)); }
    };
    const timeout = window.setTimeout(() => {
      cleanup(); reject(new Error('Meta reconnection timed out. Please try again.'));
    }, 5 * 60_000);
    window.addEventListener('bc-meta-camera', listener);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void callIOSNative(iosNativeBinding.metaConnect).catch((error) => { cleanup(); reject(error); });
  });
}
