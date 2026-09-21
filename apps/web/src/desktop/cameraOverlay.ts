import { getDesktopRuntime } from './runtime';
import { encodeNativeBytes, nativePageToken } from './nativeMedia';
import type { Options } from './wailsbindings/bettercomms/desktop-wails/internal/native/overlay/models';

export type CameraOverlaySettings = {
  position: string; size: string; clickThrough: boolean; rows: number;
};
export type CameraOverlaySession = { overlayId: string; width: number; height: number; maxFps: number };
const service = () => import('./wailsbindings/bettercomms/desktop-wails/nativemediaservice');

function requireDesktop() {
  if (getDesktopRuntime() === 'browser') throw new Error('Camera overlay requires a desktop host.');
}

export async function openCameraOverlay(options: CameraOverlaySettings): Promise<CameraOverlaySession> {
  requireDesktop();
  if (getDesktopRuntime() === 'wails') {
    const token = nativePageToken();
    return (await service()).CameraOverlayOpen(token, options as Options);
  }
  return (await import('@tauri-apps/api/core')).invoke('camera_overlay_open', options);
}

export async function updateCameraOverlay(overlayId: string, options: CameraOverlaySettings): Promise<CameraOverlaySession> {
  requireDesktop();
  if (getDesktopRuntime() === 'wails') return (await service()).CameraOverlayUpdate(nativePageToken(), overlayId, options as Options);
  return (await import('@tauri-apps/api/core')).invoke('camera_overlay_update', { overlayId, ...options });
}

export async function sendCameraOverlayFrame(session: CameraOverlaySession, rgba: Uint8Array): Promise<void> {
  requireDesktop();
  const { width, height, overlayId } = session;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 640 || height > 900 || rgba.byteLength !== width * height * 4) {
    throw new Error('Invalid camera overlay frame dimensions.');
  }
  if (getDesktopRuntime() === 'wails') {
    // Generated Go []byte bindings use base64. The caller keeps only one
    // frame in flight; the native host independently validates and paces it.
    await (await service()).CameraOverlayFrame(nativePageToken(), overlayId, width, height, encodeNativeBytes(rgba));
    return;
  }
  await (await import('@tauri-apps/api/core')).invoke('camera_overlay_frame', rgba, { headers: {
    'x-bettercomms-overlay-id': overlayId,
    'x-bettercomms-frame-width': String(width),
    'x-bettercomms-frame-height': String(height),
  } });
}

export async function closeCameraOverlay(overlayId: string): Promise<void> {
  requireDesktop();
  if (getDesktopRuntime() === 'wails') return (await service()).CameraOverlayClose(nativePageToken(), overlayId);
  return (await import('@tauri-apps/api/core')).invoke('camera_overlay_close', { overlayId });
}
