import { getDesktopRuntime } from './runtime';
import { encodeNativeBytes, nativePageToken } from './nativeMedia';

export type NativeCopilotFrame = { markId: string; sessionId: string; corner: string; width: number; height: number; x: number; y: number };
export type NativeCopilotPosition = { markId: string; corner: string; x: number; y: number; remainingMs: number; revision: number; trail: { x: number; y: number; ageMs: number }[] };
export type NativeCopilotUpdate = { sessionId: string; marks: NativeCopilotPosition[] };
export type NativeCopilotStatus = { state: 'visible' | 'hidden' | 'unavailable'; missing: string[] };
const validId = (value: string) => /^[a-zA-Z0-9-]{1,64}$/.test(value);
const coordinate = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
const corner = (value: string) => ['point', 'top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(value);

async function service() {
  if (getDesktopRuntime() !== 'wails') throw new Error('Native copilot requires the desktop host.');
  const token = nativePageToken();
  const api = await import('./wailsbindings/bettercomms/desktop-wails/nativemediaservice');
  return { api, token };
}

export async function uploadNativeCopilotFrame(frame: NativeCopilotFrame, rgba: Uint8Array): Promise<void> {
  if (!validId(frame.markId) || !validId(frame.sessionId) || !corner(frame.corner) ||
      !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.width > 480 || frame.height < 1 || frame.height > 360 ||
      rgba.byteLength !== frame.width * frame.height * 4 || !coordinate(frame.x) || !coordinate(frame.y)) throw new Error('Invalid native copilot frame.');
  const { api, token } = await service();
  return api.CopilotOverlayFrame(token, frame, encodeNativeBytes(rgba));
}

export async function syncNativeCopilot(update: NativeCopilotUpdate): Promise<NativeCopilotStatus> {
  if (!validId(update.sessionId) || update.marks.length > 5 || new Set(update.marks.map(mark => mark.markId)).size !== update.marks.length ||
      update.marks.some(mark => !validId(mark.markId) || !corner(mark.corner) || !coordinate(mark.x) || !coordinate(mark.y) ||
        !Number.isInteger(mark.remainingMs) || mark.remainingMs < 1 || mark.remainingMs > 60_000 || !Number.isSafeInteger(mark.revision) || mark.revision < 1 || mark.trail.length > 6 ||
        mark.trail.some(point => !coordinate(point.x) || !coordinate(point.y) || !Number.isInteger(point.ageMs) || point.ageMs < 0 || point.ageMs > 450))) {
    throw new Error('Invalid native copilot update.');
  }
  const { api, token } = await service();
  const status = await api.CopilotOverlaySync(token, update);
  if (!['visible', 'hidden', 'unavailable'].includes(status.state) || !Array.isArray(status.missing) || status.missing.some(id => !validId(id))) throw new Error('Invalid native copilot status.');
  return status as NativeCopilotStatus;
}

export async function clearNativeCopilot(): Promise<void> {
  const { api, token } = await service();
  return api.CopilotOverlayClear(token);
}
