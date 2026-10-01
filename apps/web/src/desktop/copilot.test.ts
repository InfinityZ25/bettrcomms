import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearNativeCopilot, syncNativeCopilot, uploadNativeCopilotFrame, type NativeCopilotFrame, type NativeCopilotPosition } from './copilot';

const mock = vi.hoisted(() => ({ token: 'fixture', runtime: 'wails', frame: vi.fn(), sync: vi.fn(), clear: vi.fn() }));
vi.mock('./runtime', () => ({ getDesktopRuntime: () => mock.runtime, readDesktopBootReport: () => ({ pageToken: mock.token }) }));
vi.mock('./wailsbindings/bettercomms/desktop-wails/nativemediaservice', () => ({ CopilotOverlayFrame: mock.frame, CopilotOverlaySync: mock.sync, CopilotOverlayClear: mock.clear }));

const frame = (): NativeCopilotFrame => ({ markId: 'mark-1', sessionId: 'capture', corner: 'point', width: 1, height: 1, x: .5, y: .25 });
const position = (): NativeCopilotPosition => ({ markId: 'mark-1', corner: 'point', x: .5, y: .25, remainingMs: 2000, revision: 1234, trail: [{ x: .4, y: .2, ageMs: 100 }] });
beforeEach(() => { vi.resetAllMocks(); mock.token = 'fixture'; mock.runtime = 'wails'; mock.sync.mockResolvedValue({ state: 'visible', missing: [] }); });

describe('typed native copilot boundary', () => {
  it('preserves authorized frame geometry and RGBA bytes', async () => {
    const pixels = new Uint8Array([255, 0, 128, 255]);
    await uploadNativeCopilotFrame(frame(), pixels);
    const [token, value, encoded] = mock.frame.mock.calls[0];
    expect(token).toBe('fixture'); expect(value).toEqual(frame());
    expect(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))).toEqual(pixels);
    await clearNativeCopilot(); expect(mock.clear).toHaveBeenCalledWith('fixture');
  });

  it.each([
    { width: 481 }, { height: 361 }, { width: 0 }, { width: 1.5 }, { markId: '../mark' },
    { sessionId: '' }, { corner: 'center' }, { x: NaN }, { x: -.1 }, { y: 1.1 },
  ])('rejects invalid frame metadata before IPC: %o', async patch => {
    await expect(uploadNativeCopilotFrame({ ...frame(), ...patch }, new Uint8Array(4))).rejects.toThrow('frame');
    expect(mock.frame).not.toHaveBeenCalled();
  });

  it('rejects malformed RGBA lengths before encoding or IPC', async () => {
    await expect(uploadNativeCopilotFrame(frame(), new Uint8Array(3))).rejects.toThrow('frame');
    expect(mock.frame).not.toHaveBeenCalled();
  });

  it.each(['visible', 'hidden', 'unavailable'] as const)('preserves native %s status and bounded movement updates', async state => {
    const update = { sessionId: 'capture', marks: [position()] };
    mock.sync.mockResolvedValue({ state, missing: ['mark-1'] });
    await expect(syncNativeCopilot(update)).resolves.toEqual({ state, missing: ['mark-1'] });
    expect(mock.sync).toHaveBeenCalledWith('fixture', update);
  });

  it.each([
    { remainingMs: 0 }, { remainingMs: 60_001 }, { remainingMs: 1.5 }, { remainingMs: Infinity },
    { revision: 0 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { x: NaN }, { y: -1 }, { markId: '../mark' }, { corner: 'center' },
    { trail: Array.from({ length: 7 }, () => ({ x: .5, y: .5, ageMs: 1 })) },
    { trail: [{ x: .5, y: .5, ageMs: 451 }] }, { trail: [{ x: .5, y: .5, ageMs: 1.5 }] },
    { trail: [{ x: .5, y: .5, ageMs: -1 }] }, { trail: [{ x: 2, y: .5, ageMs: 1 }] },
  ])('rejects invalid movement state before IPC: %o', async patch => {
    await expect(syncNativeCopilot({ sessionId: 'capture', marks: [{ ...position(), ...patch }] })).rejects.toThrow('update');
    expect(mock.sync).not.toHaveBeenCalled();
  });

  it('rejects duplicate or excessive surfaces and invalid source identities', async () => {
    await expect(syncNativeCopilot({ sessionId: '../capture', marks: [] })).rejects.toThrow('update');
    await expect(syncNativeCopilot({ sessionId: 'capture', marks: [position(), position()] })).rejects.toThrow('update');
    await expect(syncNativeCopilot({ sessionId: 'capture', marks: Array.from({ length: 6 }, (_, i) => ({ ...position(), markId: `mark-${i}` })) })).rejects.toThrow('update');
    expect(mock.sync).not.toHaveBeenCalled();
  });

  it.each([{ state: 'ready', missing: [] }, { state: 'visible', missing: ['../mark'] }, { state: 'visible', missing: null }])('rejects malformed native status: %o', async status => {
    mock.sync.mockResolvedValue(status);
    await expect(syncNativeCopilot({ sessionId: 'capture', marks: [] })).rejects.toThrow('status');
  });

  it('does not allow an unauthorized page to mutate or clear another page’s overlays', async () => {
    mock.token = '';
    await expect(uploadNativeCopilotFrame(frame(), new Uint8Array(4))).rejects.toThrow('authorise');
    await expect(syncNativeCopilot({ sessionId: 'capture', marks: [] })).rejects.toThrow('authorise');
    await expect(clearNativeCopilot()).rejects.toThrow('authorise');
    expect(mock.frame).not.toHaveBeenCalled(); expect(mock.sync).not.toHaveBeenCalled(); expect(mock.clear).not.toHaveBeenCalled();
  });

  it.each(['browser', 'legacy-tauri'])('requires a current desktop host for %s pages', async runtime => {
    mock.runtime = runtime;
    await expect(clearNativeCopilot()).rejects.toThrow('desktop host');
    await expect(syncNativeCopilot({ sessionId: 'capture', marks: [] })).rejects.toThrow('desktop host');
    expect(mock.clear).not.toHaveBeenCalled(); expect(mock.sync).not.toHaveBeenCalled();
  });
});
