import { callIOSScreenSender } from '@/desktop/iosNativeBindings';
import { readDesktopBootReport } from '@/desktop/runtime';
import type { onNativeCaptureEnded } from '@/desktop/capture';

export const hasIOSBroadcast = () => readDesktopBootReport()?.platform === 'ios';

export const iosBroadcastDriver = {
  invoke: callIOSScreenSender,
  // The local preview is a native peer too. Screen pixels never traverse IPC
  // or a canvas on the sender, and sending survives a suspended webview.
  listen: async (listener: Parameters<typeof onNativeCaptureEnded>[0]) => {
    const onEnded = (event: Event) => listener({ payload: (event as CustomEvent).detail } as Parameters<typeof listener>[0]);
    window.addEventListener('bc-ios-broadcast-ended', onEnded);
    return () => window.removeEventListener('bc-ios-broadcast-ended', onEnded);
  },
};
