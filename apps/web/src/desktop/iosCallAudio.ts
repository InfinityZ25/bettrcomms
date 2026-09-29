import { callIOSNative, iosNativeBinding } from './iosNativeBindings';
import { readDesktopBootReport } from './runtime';

const isIOSHost = () => readDesktopBootReport()?.platform === 'ios';

export async function startIOSCallAudio(): Promise<void> {
  if (!isIOSHost()) return;
  await callIOSNative(iosNativeBinding.callAudioStart);
}

export async function stopIOSCallAudio(): Promise<void> {
  if (!isIOSHost()) return;
  await callIOSNative(iosNativeBinding.callAudioStop);
}
