import { invoke, isTauri } from '@tauri-apps/api/core';

let platformPromise: Promise<string> | undefined;

async function desktopPlatform(): Promise<string> {
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
  if (await isWindowsDesktop())
    await invoke('desktop_media_permission_set', { kind, allowed: true });
}
