import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  wails: {
    Minimise: vi.fn(async () => {}),
    ToggleMaximise: vi.fn(async () => {}),
    Close: vi.fn(async () => {}),
    IsMaximised: vi.fn(async () => true),
    IsFullscreen: vi.fn(async () => false),
  },
  auth: {
    BrowserSignInBegin: vi.fn(async () => ({ state: 'waiting', code: 'ACDE-2346', confirmUrl: 'https://api.test/confirm', detail: 'Finish in your browser.', expiresAt: 1234 })),
    BrowserSignInStatus: vi.fn(async () => ({ state: 'complete', detail: 'Signed in.' })),
    BrowserSignInCancel: vi.fn(async () => {}),
  },
  tauri: {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => true),
    startDragging: vi.fn(async () => {}),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => mocks.tauri }));
vi.mock('./wailsbindings/bettercomms/desktop-wails/windowservice.js', () => mocks.wails);
vi.mock('./wailsbindings/bettercomms/desktop-wails/authservice.js', () => mocks.auth);

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
      platform: 'windows', mode: 'client-side', height: 32,
      insetStart: 0, insetEnd: 0,
      buttons: ['minimize', 'maximize', 'close'], buttonSide: 'end',
    },
    capabilities: {
      schemaVersion: 1, platform: 'windows', architecture: 'amd64',
      browserMedia: { state: 'implemented', detail: 'd' },
      nativeGameVideo: capability, nativeProcessAudio: capability,
      nativeMicrophoneDsp: capability, localTrackRecording: capability,
      mediaPermissions: capability, globalInput: capability,
      nativeOverlays: capability, notes: [],
    },
  };
}

async function loadBridge(boot?: unknown) {
  vi.resetModules();
  vi.stubGlobal('window', boot === undefined ? {} : { __BETTERCOMMS_DESKTOP__: boot });
  return import('./bridge');
}

describe('window api selection', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mocks.isTauri.mockReturnValue(false);
    Object.values(mocks.wails).forEach((fn) => fn.mockClear());
    Object.values(mocks.tauri).forEach((fn) => fn.mockClear());
  });

  it('drives the Wails window through generated bindings', async () => {
    const api = (await loadBridge(wailsBoot())).getDesktopWindowApi()!;
    await api.minimize();
    await api.toggleMaximize();
    await api.close();
    expect(await api.isMaximized()).toBe(true);
    expect(mocks.wails.Minimise).toHaveBeenCalledOnce();
    expect(mocks.wails.ToggleMaximise).toHaveBeenCalledOnce();
    expect(mocks.wails.Close).toHaveBeenCalledOnce();
    expect(mocks.wails.IsMaximised).toHaveBeenCalledOnce();
  });

  it('drives the Tauri window through its own API', async () => {
    mocks.isTauri.mockReturnValue(true);
    const api = (await loadBridge()).getDesktopWindowApi()!;
    await api.minimize();
    await api.toggleMaximize();
    expect(mocks.tauri.minimize).toHaveBeenCalledOnce();
    expect(mocks.tauri.toggleMaximize).toHaveBeenCalledOnce();
  });

  it('offers no window API in a browser', async () => {
    expect((await loadBridge()).getDesktopWindowApi()).toBeNull();
  });

  it('uses Wails drag-region CSS only in Wails', async () => {
    const bridge = await loadBridge(wailsBoot());
    expect(bridge.dragRegionStyle()).toEqual({});
    expect(bridge.noDragStyle()).toEqual({});
    expect(bridge.nativeNonClientRegion('caption')).toBe('caption');
    expect(bridge.nativeNonClientRegion('minimize')).toBe('minimize');
    expect(bridge.nativeNonClientRegion('maximize')).toBe('maximize');
    expect(bridge.nativeNonClientRegion('close')).toBe('close');
  });

  it('keeps portable Wails drag regions outside Windows', async () => {
    const boot = wailsBoot();
    boot.platform = 'linux';
    boot.capabilities.platform = 'linux';
    boot.windowControls.platform = 'linux';
    const bridge = await loadBridge(boot);
    expect(bridge.dragRegionStyle()).toEqual({ '--wails-draggable': 'drag' });
    expect(bridge.noDragStyle()).toEqual({ '--wails-draggable': 'no-drag' });
    expect(bridge.nativeNonClientRegion('maximize')).toBeUndefined();
  });
});

describe('browser sign-in hand-off', () => {
  function signInBoot() {
    const boot = wailsBoot();
    boot.authReturn = { state: 'experimental', detail: 'browser hand-off', fallback: '' };
    return boot;
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
    mocks.isTauri.mockReturnValue(false);
    Object.values(mocks.auth).forEach((fn) => fn.mockClear());
  });

  it('starts and polls the hand-off through the generated bindings', async () => {
    const api = (await loadBridge(signInBoot())).getDesktopSignInApi()!;

    expect(await api.begin()).toEqual({
      state: 'waiting',
      code: 'ACDE-2346',
      confirmUrl: 'https://api.test/confirm',
      detail: 'Finish in your browser.',
      expiresAt: 1234,
    });
    expect(await api.status()).toEqual({ state: 'complete', detail: 'Signed in.' });
    await api.cancel();
    expect(mocks.auth.BrowserSignInBegin).toHaveBeenCalledOnce();
    expect(mocks.auth.BrowserSignInCancel).toHaveBeenCalledOnce();
  });

  // Go's zero value for the state enum is the empty string. Treating it as
  // "waiting" would leave the window polling a sign-in that is not running.
  it('reports an unrecognised host state as a failure', async () => {
    mocks.auth.BrowserSignInStatus.mockResolvedValueOnce({ state: '', detail: '' } as never);
    const api = (await loadBridge(signInBoot())).getDesktopSignInApi()!;
    const status = await api.status();
    expect(status.state).toBe('failed');
    expect(status.detail).not.toBe('');
  });

  it('offers no hand-off in a browser or in Tauri', async () => {
    expect((await loadBridge()).getDesktopSignInApi()).toBeNull();
    mocks.isTauri.mockReturnValue(true);
    expect((await loadBridge()).getDesktopSignInApi()).toBeNull();
  });

  // A host with no API proxy has nowhere to put a session, and says so in the
  // boot report. Opening a browser there would lead nowhere.
  it('offers no hand-off when the host reports it unavailable', async () => {
    expect((await loadBridge(wailsBoot())).getDesktopSignInApi()).toBeNull();
  });
});
