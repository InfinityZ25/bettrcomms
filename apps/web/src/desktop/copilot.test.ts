import { beforeEach, expect, it, vi } from 'vitest';
import { invokeNativeCopilot } from './copilot';
const mock = vi.hoisted(() => ({ token: 'fixture', frame: vi.fn(), clear: vi.fn() }));
vi.mock('./runtime', () => ({ getDesktopRuntime: () => 'wails', readDesktopBootReport: () => ({ pageToken: mock.token }) }));
vi.mock('./wailsbindings/bettercomms/desktop-wails/nativemediaservice', () => ({ CopilotOverlayFrame: mock.frame, CopilotOverlayClear: mock.clear }));
const headers = { 'x-copilot-id': 'mark-1', 'x-copilot-session': 'capture', 'x-copilot-corner': 'point', 'x-copilot-width': '1', 'x-copilot-height': '1', 'x-copilot-x': '0.5', 'x-copilot-y': '0.25' };
beforeEach(() => { vi.resetAllMocks(); mock.token = 'fixture'; });

it('preserves authorised copilot geometry and RGBA bytes', async () => {
  const pixels = new Uint8Array([255, 0, 128, 255]);
  await invokeNativeCopilot('copilot_overlay_frame', pixels, { headers });
  const [token, frame, encoded] = mock.frame.mock.calls[0];
  expect(token).toBe('fixture');
  expect(frame).toEqual({ markId: 'mark-1', sessionId: 'capture', corner: 'point', width: 1, height: 1, x: .5, y: .25 });
  expect(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))).toEqual(pixels);
  await invokeNativeCopilot('copilot_overlay_clear');
  expect(mock.clear).toHaveBeenCalledWith('fixture');
});

it('rejects oversized frames and out-of-source coordinates before IPC', async () => {
  await expect(invokeNativeCopilot('copilot_overlay_frame', new Uint8Array(4), { headers: { ...headers, 'x-copilot-width': '481' } })).rejects.toThrow('frame');
  await expect(invokeNativeCopilot('copilot_overlay_frame', new Uint8Array(4), { headers: { ...headers, 'x-copilot-x': 'NaN' } })).rejects.toThrow('frame');
  expect(mock.frame).not.toHaveBeenCalled();
});

it('does not allow an unauthorised page to clear another page’s overlays', async () => {
  mock.token = '';
  await expect(invokeNativeCopilot('copilot_overlay_clear')).rejects.toThrow('authorise');
  expect(mock.clear).not.toHaveBeenCalled();
});
