import { callIOSNative, iosNativeBinding } from '@/desktop/iosNativeBindings';
import { readDesktopBootReport } from '@/desktop/runtime';

export const META_GLASSES_CAMERA_ID = 'bettercomms:meta-glasses-camera';
export const hasMetaGlassesCamera = () =>
  readDesktopBootReport()?.platform === 'ios';

type MetaEvent =
  | { kind: 'frame'; jpeg: string; width: number; height: number }
  | { kind: 'error'; message: string }
  | { kind: 'stopped' | 'streaming' | 'starting' | 'connecting' | 'registered' };

// Call video and the Settings preview may use the same SDK session together.
// Stopping one canvas must not disconnect the other's glasses stream.
let activeConsumers = 0;

/** Convert native DAT frames into an ordinary call camera track on iOS. */
export async function startMetaGlassesCamera(): Promise<{
  track: MediaStreamTrack;
  dispose: () => void;
}> {
  if (!hasMetaGlassesCamera()) throw new Error('Meta glasses camera requires the iPhone app.');
  const canvas = document.createElement('canvas');
  if (typeof canvas.captureStream !== 'function') {
    throw new Error('This iPhone webview cannot publish the glasses camera.');
  }
  canvas.width = 360;
  canvas.height = 640;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a glasses camera preview.');
  const stream = canvas.captureStream(15);
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
  const timeout = window.setTimeout(() => {
    rejectFirst(new Error('Glasses camera did not send video. Check Meta AI and try again.'));
  }, 30_000);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(timeout);
    window.removeEventListener('bc-meta-camera', onMetaEvent);
    track.stop();
    if (ownsNative && --activeConsumers === 0)
      void callIOSNative(iosNativeBinding.metaStop).catch(() => {});
  };
  const onMetaEvent = (event: Event) => {
    if (disposed) return;
    const detail = (event as CustomEvent<MetaEvent>).detail;
    if (!detail) return;
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
  try {
    activeConsumers++;
    ownsNative = true;
    await callIOSNative(iosNativeBinding.metaStart);
    await ready;
    return { track, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
