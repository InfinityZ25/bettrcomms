import { invoke, isTauri } from '@tauri-apps/api/core';
import { getDesktopRuntime, readDesktopBootReport } from '../desktop/runtime';
import { nativePageToken } from '../desktop/nativeMedia';

let platformPromise: Promise<string> | undefined;

async function desktopPlatform(): Promise<string> {
  if (getDesktopRuntime() === 'wails') return readDesktopBootReport()?.platform ?? 'unknown';
  if (!isTauri()) return 'web';
  platformPromise ??= invoke<{ platform: string }>('desktop_media_capabilities')
    .then((capabilities) => capabilities.platform)
    .catch(() => (/Windows/i.test(navigator.userAgent) ? 'windows' : 'unknown'));
  return platformPromise;
}

export async function isWindowsDesktop(): Promise<boolean> {
  return (await desktopPlatform()) === 'windows';
}

/** Call only from an explicit microphone/camera action, never on mount. */
export async function allowDesktopCapture(
  kind: 'microphone' | 'camera',
): Promise<void> {
  // Wails has no Profile4 grant to write. On Windows, getUserMedia uses the
  // normal WebView2 permission decision/prompt as well as OS privacy settings.
  if (getDesktopRuntime() === 'wails') return;
  if (await isWindowsDesktop())
    await invoke('desktop_media_permission_set', { kind, allowed: true });
}

export async function openDesktopPrivacySettings(kind: 'microphone' | 'camera'): Promise<void> {
  if (!(await isWindowsDesktop())) throw new Error('Windows privacy settings are available only in the Windows desktop app.');
  if (getDesktopRuntime() === 'wails') {
    const token = nativePageToken();
    const api = await import('../desktop/wailsbindings/bettercomms/desktop-wails/nativemediaservice');
    await api.MediaPermissionOpenSettings(token, kind);
  } else {
    await invoke('open_media_privacy_settings', { kind });
  }
}
