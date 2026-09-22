import { getDesktopRuntime } from './runtime';
import { encodeNativeBytes, nativePageToken } from './nativeMedia';

export async function invokeNativeCopilot(command: string, rgba?: Uint8Array, options?: { headers: Record<string, string> }): Promise<void> {
  if (getDesktopRuntime() !== 'wails') {
    const { invoke } = await import('@tauri-apps/api/core');
    return rgba ? invoke(command, rgba, options) : invoke(command);
  }
  const token = nativePageToken();
  const api = await import('./wailsbindings/bettercomms/desktop-wails/nativemediaservice');
  if (command === 'copilot_overlay_clear') return api.CopilotOverlayClear(token);
  if (command !== 'copilot_overlay_frame' || !rgba || !options) throw new Error('Invalid native copilot operation.');
  const headers = options.headers;
  const width = Number(headers['x-copilot-width']), height = Number(headers['x-copilot-height']);
  const x = Number(headers['x-copilot-x']), y = Number(headers['x-copilot-y']);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 480 || height < 1 || height > 360 ||
      rgba.byteLength !== width * height * 4 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error('Invalid native copilot frame.');
  }
  return api.CopilotOverlayFrame(token, {
    markId: headers['x-copilot-id'], sessionId: headers['x-copilot-session'], corner: headers['x-copilot-corner'], width, height, x, y,
  }, encodeNativeBytes(rgba));
}
