import { describe, expect, it, vi } from 'vitest';

/*
  The Wails runtime's non-client region tracker runs as an import side effect,
  so what this pins is whether the package is imported at all — and in which
  host. Every regression here is invisible in a browser and looks, on Windows,
  like a title bar the window manager has never heard of.
*/
const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  loads: { count: 0 },
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@wailsio/runtime', () => {
  mocks.loads.count += 1;
  return { Window: {} };
});

function wailsBoot() {
  const capability = { state: 'unavailable', detail: 'd', fallback: 'f' };
  return {
    schemaVersion: 1,
    runtime: 'wails',
    hostVersion: '0.0.1-wails',
    platform: 'windows',
    architecture: 'amd64',
    apiOrigin: '',
    authReturn: capability,
    windowControls: {
      platform: 'windows',
      mode: 'client-side',
      height: 40,
      insetStart: 0,
      insetEnd: 0,
      buttons: ['minimize', 'maximize', 'close'],
      buttonSide: 'end',
    },
    capabilities: {
      schemaVersion: 1,
      platform: 'windows',
      architecture: 'amd64',
      browserMedia: { state: 'implemented', detail: 'd' },
      nativeGameVideo: capability,
      nativeProcessAudio: capability,
      nativeMicrophoneDsp: capability,
      localTrackRecording: capability,
      mediaPermissions: capability,
      globalInput: capability,
      nativeOverlays: capability,
      notes: [],
    },
  };
}

async function load(boot?: unknown) {
  vi.resetModules();
  mocks.loads.count = 0;
  vi.stubGlobal(
    'window',
    boot === undefined ? {} : { __BETTERCOMMS_DESKTOP__: boot },
  );
  return import('./wailsFrontendRuntime');
}

/** The import is dynamic, so the load lands a microtask later. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the Wails frontend runtime', () => {
  it('is loaded in the Wails host, where it reports the title bar to Windows', async () => {
    const module = await load(wailsBoot());
    expect(module.startWailsFrontendRuntime()).toBe(true);
    await settle();
    // The package itself, not a stand-in for it: the region tracker is one of
    // its import side effects, so being imported is the whole behaviour.
    expect(mocks.loads.count).toBeGreaterThan(0);
  });

  it('is loaded once however many times it is asked for', async () => {
    const module = await load(wailsBoot());
    expect(module.startWailsFrontendRuntime()).toBe(true);
    expect(module.startWailsFrontendRuntime()).toBe(false);
    expect(module.startWailsFrontendRuntime()).toBe(false);
  });

  it('is left alone in a browser, which has no host to report regions to', async () => {
    const module = await load();
    expect(module.startWailsFrontendRuntime()).toBe(false);
  });

  it('is left alone under Tauri, which drags through its own IPC', async () => {
    mocks.isTauri.mockReturnValue(true);
    const module = await load();
    expect(module.startWailsFrontendRuntime()).toBe(false);
    mocks.isTauri.mockReturnValue(false);
  });
});
