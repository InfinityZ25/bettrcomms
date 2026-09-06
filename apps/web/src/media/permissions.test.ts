import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock('@tauri-apps/api/core', () => mocks);

describe('desktop media permission platform gating', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
    mocks.isTauri.mockReturnValue(true);
  });

  it('uses browser media directly in the macOS Tauri host', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'desktop_media_capabilities')
        return { platform: 'macos' };
      throw new Error(`unexpected command: ${command}`);
    });
    const getUserMedia = vi.fn(async () => ({ id: 'browser-stream' }));
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh)',
      mediaDevices: { getUserMedia },
    });
    const { allowDesktopCapture } = await import('./permissions');

    await allowDesktopCapture('microphone');
    await navigator.mediaDevices.getUserMedia({ audio: true });

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('desktop_media_capabilities');
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  });
});
