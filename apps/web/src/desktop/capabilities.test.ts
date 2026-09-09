import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopCapabilityName } from './types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/core', () => mocks);

const NATIVE: DesktopCapabilityName[] = [
  'nativeGameVideo',
  'nativeProcessAudio',
  'nativeMicrophoneDsp',
  'localTrackRecording',
  'mediaPermissions',
  'globalInput',
  'nativeOverlays',
];

function capability(state: string) {
  return { state, detail: 'detail', fallback: 'browser path' };
}

function wailsBoot() {
  return {
    schemaVersion: 1,
    runtime: 'wails',
    hostVersion: '0.0.1-wails',
    platform: 'windows',
    architecture: 'amd64',
    apiOrigin: '',
    authReturn: capability('unavailable'),
    windowControls: {
      platform: 'windows',
      mode: 'client-side',
      height: 32,
      insetStart: 0,
      insetEnd: 0,
      buttons: ['minimize', 'maximize', 'close'],
      buttonSide: 'end',
    },
    capabilities: {
      schemaVersion: 1,
      platform: 'windows',
      architecture: 'amd64',
      browserMedia: capability('implemented'),
      ...Object.fromEntries(
        NATIVE.map((name) => [
          name,
          {
            state: 'unavailable',
            detail: 'not ported to the Wails host',
            fallback: 'browser path',
          },
        ]),
      ),
      notes: ['this host contains no media code'],
    },
  };
}

async function load(boot?: unknown) {
  vi.resetModules();
  vi.stubGlobal(
    'window',
    boot === undefined ? {} : { __BETTERCOMMS_DESKTOP__: boot },
  );
  return import('./capabilities');
}

describe('capability reporting', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mocks.isTauri.mockReturnValue(false);
    mocks.invoke.mockReset();
  });

  // The point of the whole module: the Wails host must never be presented as
  // having native capture, native audio processing, GPU denoisers, or native
  // recording, because none of that code has been ported to it.
  it('reports every native capability unavailable in the Wails host', async () => {
    const capabilities = await load(wailsBoot());
    const report = capabilities.getDesktopCapabilities();

    for (const name of NATIVE) {
      expect(report[name].state).toBe('unavailable');
      expect(capabilities.hasDesktopCapability(name)).toBe(false);
      expect(capabilities.describeCapabilityFallback(name)).not.toBe('');
    }
    expect(report.browserMedia.state).toBe('implemented');
    expect(capabilities.hasDesktopCapability('browserMedia')).toBe(true);
    expect(capabilities.describeCapabilityFallback('browserMedia')).toBe('');
  });

  it('reports every native capability unavailable in a browser', async () => {
    const capabilities = await load();
    const report = capabilities.getDesktopCapabilities();

    for (const name of NATIVE) {
      expect(report[name].state).toBe('unavailable');
      expect(report[name].fallback).toBeTruthy();
    }
  });

  it('stays conservative for Tauri until the host has answered', async () => {
    mocks.isTauri.mockReturnValue(true);
    const capabilities = await load();

    for (const name of NATIVE) {
      expect(capabilities.hasDesktopCapability(name)).toBe(false);
    }
  });

  it('takes the Tauri host at its word once it answers', async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({
      platform: 'windows',
      architecture: 'x86_64',
      nativeGameVideo: { state: 'implemented', detail: 'Windows Graphics Capture' },
      nativeProcessAudio: { state: 'experimental', detail: 'process loopback' },
      localTrackRecording: { state: 'implemented', detail: 'native MP4 remux' },
      notes: ['native sharing requires the bundled FFmpeg runtime'],
    });
    const capabilities = await load();

    const report = await capabilities.loadDesktopCapabilities();

    expect(mocks.invoke).toHaveBeenCalledWith('desktop_media_capabilities');
    expect(report.platform).toBe('windows');
    expect(report.nativeGameVideo.state).toBe('implemented');
    expect(report.nativeProcessAudio.state).toBe('experimental');
    // Capabilities outside the Tauri report schema are not invented here.
    expect(report.globalInput.state).toBe('unavailable');
    expect(report.globalInput.detail).toContain('probes it directly');
  });

  it('keeps the conservative report when the Tauri command is missing', async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockRejectedValue(new Error('Command not found'));
    const capabilities = await load();

    const report = await capabilities.loadDesktopCapabilities();

    expect(report.nativeGameVideo.state).toBe('unavailable');
  });

  it('summarises the runtime for diagnostics without identifiers', async () => {
    const capabilities = await load(wailsBoot());

    const summary = capabilities.describeDesktopRuntime();

    expect(summary).toMatchObject({
      runtime: 'wails',
      hostVersion: '0.0.1-wails',
      platform: 'windows',
      architecture: 'amd64',
    });
    expect(summary.capabilities.nativeGameVideo).toBe('unavailable');
    expect(JSON.stringify(summary)).not.toContain('token');
  });
});
