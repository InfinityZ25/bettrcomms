import { Call } from '@wailsio/runtime';
import { nativePageToken } from './nativeMedia';
import { readDesktopBootReport } from './runtime';

const isIOSHost = () => readDesktopBootReport()?.platform === 'ios';

export async function startIOSCallAudio(): Promise<void> {
  if (!isIOSHost()) return;
  await Call.ByName('bettercomms/desktop-wails.IOSCallAudioService.CallAudioStart', nativePageToken());
}

export async function stopIOSCallAudio(): Promise<void> {
  if (!isIOSHost()) return;
  await Call.ByName('bettercomms/desktop-wails.IOSCallAudioService.CallAudioStop', nativePageToken());
}
