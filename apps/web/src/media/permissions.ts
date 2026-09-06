import { invoke, isTauri } from '@tauri-apps/api/core';
/** Call only from an explicit microphone/camera action, never on mount. */
export async function allowDesktopCapture(
  kind: 'microphone' | 'camera',
): Promise<void> {
  if (isTauri())
    await invoke('desktop_media_permission_set', { kind, allowed: true });
}
