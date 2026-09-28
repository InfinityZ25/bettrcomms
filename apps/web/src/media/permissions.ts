import { getDesktopRuntime, readDesktopBootReport } from '../desktop/runtime';
import { nativePageToken } from '../desktop/nativeMedia';

async function desktopPlatform(): Promise<string> {
  if (getDesktopRuntime() === 'wails') return readDesktopBootReport()?.platform ?? 'unknown';
  return 'web';
}

export async function isWindowsDesktop(): Promise<boolean> {
  return (await desktopPlatform()) === 'windows';
}

/** Call only from an explicit microphone/camera action, never on mount. */
export async function allowDesktopCapture(
  kind: 'microphone' | 'camera',
): Promise<void> {
  // WebView2 uses its normal permission decision and OS privacy settings.
  void kind;
}

export async function openDesktopPrivacySettings(kind: 'microphone' | 'camera'): Promise<void> {
  if (!(await isWindowsDesktop())) throw new Error('Windows privacy settings are available only in the Windows desktop app.');
  const token = nativePageToken();
  const api = await import('../desktop/wailsbindings/bettercomms/desktop-wails/nativemediaservice');
  await api.MediaPermissionOpenSettings(token, kind);
}
