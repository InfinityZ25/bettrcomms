import { callIOSScreenSender } from '@/desktop/iosNativeBindings';
import { readDesktopBootReport } from '@/desktop/runtime';
import type { onNativeCaptureEnded } from '@/desktop/capture';

export const hasIOSBroadcast = () => readDesktopBootReport()?.platform === 'ios';

// One per page load. The host records it with each broadcast, so a reloaded
// page can tell a share it never started from its own.
// getRandomValues, unlike randomUUID, also works outside secure contexts, and
// this runs at import on every platform.
const pageOwner = Array.from(crypto.getRandomValues(new Uint8Array(16)),
  (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Ends a whole-phone broadcast left behind by an earlier load of this page.
 *
 * The broadcast sends from the extension, not the page, so a reload (or a
 * WebView crash that iOS recovers by reloading) would otherwise leave the
 * screen streaming with nothing on the page able to stop it. Called once at
 * boot; a heartbeat would instead stop sharing whenever iOS suspends the page.
 */
export function releaseOrphanedIOSBroadcast() {
  if (!hasIOSBroadcast()) return;
  void callIOSScreenSender('native_screen_release_orphans', { owner: pageOwner }).catch(() => undefined);
}

// The share this page started and has not stopped, if any.
let liveSession: string | undefined;

export const iosBroadcastDriver = {
  invoke: (async (command: string, args: Record<string, unknown> = {}) => {
    const result = await callIOSScreenSender(command,
      command === 'native_screen_start' ? { ...args, owner: pageOwner } : args);
    if (command === 'native_screen_start') liveSession = (result as { sessionId?: string } | undefined)?.sessionId;
    if (command === 'native_screen_stop' && args.sessionId === liveSession) liveSession = undefined;
    return result;
  }) as typeof callIOSScreenSender,
  // Leaving the call while the picker is open must close the picker too.
  cancelPending: () => callIOSScreenSender('native_screen_cancel_pending').then(() => undefined, () => undefined),
  // The local preview is a native peer too. Screen pixels never traverse IPC
  // or a canvas on the sender, and sending survives a suspended webview.
  listen: async (listener: Parameters<typeof onNativeCaptureEnded>[0]) => {
    const end = (detail: { sessionId: string; reason: string }) => {
      if (detail.sessionId === liveSession) liveSession = undefined;
      listener({ payload: detail } as Parameters<typeof listener>[0]);
    };
    const onEnded = (event: Event) => end((event as CustomEvent).detail);
    // Stopping from the iOS indicator while BetterComms is in the background
    // sends the ended event into a suspended webview, where iOS may drop it.
    // Coming back, ask the host whether this page's share is still live.
    const onVisible = () => {
      const session = liveSession;
      if (document.visibilityState !== 'visible' || !session) return;
      void callIOSScreenSender<{ sessionId?: string }>('native_screen_active').then((active) => {
        if (liveSession === session && active?.sessionId !== session)
          end({ sessionId: session, reason: 'Screen broadcast ended.' });
      }, () => undefined);
    };
    window.addEventListener('bc-ios-broadcast-ended', onEnded);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('bc-ios-broadcast-ended', onEnded);
      document.removeEventListener('visibilitychange', onVisible);
    };
  },
};
