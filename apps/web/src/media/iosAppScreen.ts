import { callIOSNative, iosNativeBinding } from '@/desktop/iosNativeBindings';
import { readDesktopBootReport } from '@/desktop/runtime';

export const hasIOSAppScreen = () => readDesktopBootReport()?.platform === 'ios';

type ScreenEvent =
  | { kind: 'frame'; jpeg: string; width: number; height: number }
  | { kind: 'error'; message: string }
  | { kind: 'starting' | 'capturing' | 'stopped' };

/** Share the foreground BetterComms screen; other apps require a broadcast extension. */
export async function startIOSAppScreen(): Promise<{
  track: MediaStreamTrack;
  dispose: () => void;
}> {
  if (!hasIOSAppScreen()) throw new Error('iPhone screen capture requires the native app.');
  const canvas = document.createElement('canvas');
  if (typeof canvas.captureStream !== 'function')
    throw new Error('This iPhone webview cannot publish the screen capture.');
  canvas.width = 360;
  canvas.height = 640;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a screen-share track.');
  const track = canvas.captureStream(8).getVideoTracks()[0];
  if (!track) throw new Error('Could not create a screen-share track.');
  track.contentHint = 'detail';
  let disposed = false;
  let firstFrame = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timeout = window.setTimeout(() => rejectReady(new Error('iPhone screen capture did not start.')), 30_000);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(timeout);
    window.removeEventListener('bc-ios-app-screen', onScreenEvent);
    track.stop();
    void callIOSNative(iosNativeBinding.screenStop).catch(() => {});
  };
  const onScreenEvent = (event: Event) => {
    if (disposed) return;
    const detail = (event as CustomEvent<ScreenEvent>).detail;
    if (!detail) return;
    if (detail.kind === 'error' || detail.kind === 'stopped') {
      if (!firstFrame) rejectReady(new Error(detail.kind === 'error' ? detail.message : 'Screen capture stopped.'));
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
        resolveReady();
      }
    };
    image.src = `data:image/jpeg;base64,${detail.jpeg}`;
  };
  window.addEventListener('bc-ios-app-screen', onScreenEvent);
  try {
    await callIOSNative(iosNativeBinding.screenStart);
    await ready;
    return { track, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
