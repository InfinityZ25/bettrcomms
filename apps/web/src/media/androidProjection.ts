import { Call } from '@wailsio/runtime';
import { nativePageToken } from '@/desktop/nativeMedia';
async function callAndroidScreenSender<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return await Call.ByID(0xBC170102, nativePageToken(), command, args) as T;
}
import { readDesktopBootReport } from '@/desktop/runtime';
import type { onNativeCaptureEnded } from '@/desktop/capture';

export const hasAndroidProjection = () => readDesktopBootReport()?.platform === 'android';

// One per page load. The host records it with each screen share, so a reloaded
// page can tell a share it never started from its own.
// getRandomValues, unlike randomUUID, also works outside secure contexts, and
// this runs at import on every platform.
const pageOwner = Array.from(crypto.getRandomValues(new Uint8Array(16)),
  (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Ends a whole-phone screen share left behind by an earlier load of this page.
 *
 * The screen share sends from the native foreground service, not the page, so a reload (or a
 * WebView crash that Android recovers by reloading) would otherwise leave the
 * screen streaming with nothing on the page able to stop it. Called once at
 * boot; a heartbeat would instead stop sharing whenever Android suspends the page.
 */
export function releaseOrphanedAndroidProjection() {
  if (!hasAndroidProjection()) return;
  void callAndroidScreenSender('native_screen_release_orphans', { owner: pageOwner }).catch(() => undefined);
}

// The share this page started and has not stopped, if any.
let liveSession: string | undefined;

export const androidProjectionDriver = {
  invoke: (async (command: string, args: Record<string, unknown> = {}) => {
    const result = await callAndroidScreenSender(command,
      command === 'native_screen_start' ? { ...args, owner: pageOwner } : args);
    if (command === 'native_screen_start') liveSession = (result as { sessionId?: string } | undefined)?.sessionId;
    if (command === 'native_screen_stop' && args.sessionId === liveSession) liveSession = undefined;
    return result;
  }) as typeof callAndroidScreenSender,
  // Leaving the call invalidates pending consent; a late result cannot capture.
  cancelPending: () => callAndroidScreenSender('native_screen_cancel_pending').then(() => undefined, () => undefined),
  // The local preview is a native peer too. Screen pixels never traverse IPC
  // or a canvas on the sender, and sending survives a suspended webview.
  listen: async (listener: Parameters<typeof onNativeCaptureEnded>[0]) => {
    const end = (detail: { sessionId: string; reason: string }) => {
      if (detail.sessionId === liveSession) liveSession = undefined;
      listener({ payload: detail } as Parameters<typeof listener>[0]);
    };
    const onEnded = (event: Event) => end((event as CustomEvent).detail);
    // Stopping from the Android indicator while BetterComms is in the background
    // sends the ended event into a suspended webview, where Android may drop it.
    // Coming back, ask the host whether this page's share is still live.
    const onVisible = () => {
      const session = liveSession;
      if (document.visibilityState !== 'visible' || !session) return;
      void callAndroidScreenSender<{ sessionId?: string }>('native_screen_active').then((active) => {
        if (liveSession === session && active?.sessionId !== session)
          end({ sessionId: session, reason: 'Screen sharing ended.' });
      }, () => undefined);
    };
    window.addEventListener('bc-android-screen-ended', onEnded);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('bc-android-screen-ended', onEnded);
      document.removeEventListener('visibilitychange', onVisible);
    };
  },
};
