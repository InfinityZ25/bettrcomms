import { callIOSNative, iosNativeBinding } from './iosNativeBindings';
import { Call } from '@wailsio/runtime';
import { nativePageToken } from './nativeMedia';
import { readDesktopBootReport } from './runtime';

const isIOSHost = () => readDesktopBootReport()?.platform === 'ios';

export async function startIOSCallAudio(): Promise<void> {
  if (readDesktopBootReport()?.platform === 'android') {
    await Call.ByID(0xBC170101, nativePageToken(), true);
    return;
  }
  if (!isIOSHost()) return;
  await callIOSNative(iosNativeBinding.callAudioStart);
}

export async function stopIOSCallAudio(): Promise<void> {
  if (readDesktopBootReport()?.platform === 'android') {
    await Call.ByID(0xBC170101, nativePageToken(), false);
    return;
  }
  if (!isIOSHost()) return;
  await callIOSNative(iosNativeBinding.callAudioStop);
}
