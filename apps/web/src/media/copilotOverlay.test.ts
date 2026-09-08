import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachCopilotOverlay } from './copilotOverlay';
import type { VisualCopilot } from './visualCopilot';

const host = vi.hoisted(() => ({ native: true, session: undefined as string | undefined, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => host.native, invoke: host.invoke }));
vi.mock('./nativeCaptureRegistry', () => ({ nativeScreenSessionForTrack: () => host.session }));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); host.invoke.mockReset(); host.native = true; host.session = undefined; });

describe('external copilot availability', () => {
  it.each(['browser', 'old-host', 'browser-capture', 'native-capture'])('explains %s without idle polling', async kind => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => '{"enabled":true}' });
    host.native = kind !== 'browser';
    host.session = kind === 'native-capture' ? 'session' : undefined;
    host.invoke.mockImplementation(() => kind === 'old-host' ? Promise.reject('Command copilot_overlay_clear not found') : Promise.resolve());
    const controller = { getSource: () => ({}), getSnapshot: () => ({ marks: [] }), subscribe: () => () => {} } as unknown as VisualCopilot;
    const status = vi.fn();
    const stop = attachCopilotOverlay(controller, () => ({}), status);
    try {
      await flush();
      const expected = { browser: 'Browser sharing', 'old-host': 'External overlay unavailable', 'browser-capture': 'Desktop browser capture', 'native-capture': 'Native overlay ready' }[kind]!;
      expect(status).toHaveBeenLastCalledWith(expect.stringContaining(expected));
      const calls = host.invoke.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(host.invoke).toHaveBeenCalledTimes(calls);
    } finally { stop(); await flush(); }
  });
});
