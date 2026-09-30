import { callIOSScreenSender } from '@/desktop/iosNativeBindings';
import { readDesktopBootReport } from '@/desktop/runtime';
import type { onNativeCaptureEnded } from '@/desktop/capture';

export const hasIOSBroadcast = () => readDesktopBootReport()?.platform === 'ios';

export const iosBroadcastDriver = {
  invoke: callIOSScreenSender,
  // Leaving the call while the picker is open must close the picker too.
  cancelPending: () => callIOSScreenSender('native_screen_cancel_pending').then(() => undefined, () => undefined),
  // The local preview is a native peer too. Screen pixels never traverse IPC
  // or a canvas on the sender, and sending survives a suspended webview.
  listen: async (listener: Parameters<typeof onNativeCaptureEnded>[0]) => {
    const onEnded = (event: Event) => listener({ payload: (event as CustomEvent).detail } as Parameters<typeof listener>[0]);
    window.addEventListener('bc-ios-broadcast-ended', onEnded);
    return () => window.removeEventListener('bc-ios-broadcast-ended', onEnded);
  },
};
