import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBootReport } from './types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/core', () => mocks);

function capability(state = 'unavailable') {
  return { state, detail: 'detail', fallback: 'browser path' };
}

function validBoot(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runtime: 'wails',
    hostVersion: '0.0.1-wails',
    platform: 'windows',
    architecture: 'amd64',
    apiOrigin: 'http://127.0.0.1:8080',
    authReturn: capability(),
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
      nativeGameVideo: capability(),
      nativeProcessAudio: capability(),
      nativeMicrophoneDsp: capability(),
      localTrackRecording: capability(),
      mediaPermissions: capability(),
      globalInput: capability(),
      nativeOverlays: capability(),
      notes: ['this host contains no media code'],
    },
  };
}

async function loadRuntime(boot?: unknown) {
  vi.resetModules();
  vi.stubGlobal('window', boot === undefined ? {} : { __BETTERCOMMS_DESKTOP__: boot });
  return import('./runtime');
}

describe('desktop runtime detection', () => {
  beforeEach(() => {
    mocks.isTauri.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  it('detects the Wails host from its injected boot report', async () => {
    const runtime = await loadRuntime(validBoot());

    expect(runtime.getDesktopRuntime()).toBe('wails');
    expect(runtime.isDesktopShell()).toBe(true);
    // Native media features stay Tauri-only, whatever shell is hosting.
    expect(runtime.hasTauriNativeCommands()).toBe(false);
    expect(runtime.getDesktopApiOrigin()).toBe('http://127.0.0.1:8080');
  });

  it('detects the Tauri host and reports no boot global', async () => {
    mocks.isTauri.mockReturnValue(true);
    const runtime = await loadRuntime();

    expect(runtime.getDesktopRuntime()).toBe('tauri');
    expect(runtime.hasTauriNativeCommands()).toBe(true);
    expect(runtime.readDesktopBootReport()).toBeNull();
    expect(runtime.getDesktopApiOrigin()).toBeNull();
  });

  it('reports a browser when neither host is present', async () => {
    const runtime = await loadRuntime();

    expect(runtime.getDesktopRuntime()).toBe('browser');
    expect(runtime.isDesktopShell()).toBe(false);
  });

  it('prefers the Wails report even if a Tauri marker is also present', async () => {
    mocks.isTauri.mockReturnValue(true);
    const runtime = await loadRuntime(validBoot());

    expect(runtime.getDesktopRuntime()).toBe('wails');
  });
});

describe('desktop boot report validation', () => {
  beforeEach(() => {
    mocks.isTauri.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  it('accepts a complete report', async () => {
    const runtime = await loadRuntime(validBoot());
    const report = runtime.readDesktopBootReport() as DesktopBootReport;

    expect(report.hostVersion).toBe('0.0.1-wails');
    expect(report.capabilities.nativeGameVideo.state).toBe('unavailable');
    expect(report.windowControls.buttons).toHaveLength(3);
  });

  it.each([
    ['a non-object', 'nope'],
    ['a wrong runtime name', { ...validBoot(), runtime: 'tauri' }],
    ['an unknown schema version', { ...validBoot(), schemaVersion: 2 }],
    ['missing capabilities', { ...validBoot(), capabilities: undefined }],
    [
      'a capability with an unknown state',
      {
        ...validBoot(),
        capabilities: {
          ...(validBoot().capabilities as object),
          globalInput: { state: 'working', detail: '' },
        },
      },
    ],
    [
      'window controls with an unknown button',
      {
        ...validBoot(),
        windowControls: {
          ...(validBoot().windowControls as object),
          buttons: ['minimize', 'detonate'],
        },
      },
    ],
    [
      'window controls with a negative height',
      {
        ...validBoot(),
        windowControls: {
          ...(validBoot().windowControls as object),
          height: -1,
        },
      },
    ],
  ])('rejects %s', async (_name, boot) => {
    const runtime = await loadRuntime(boot);

    expect(runtime.readDesktopBootReport()).toBeNull();
    expect(runtime.getDesktopRuntime()).toBe('browser');
  });

  // The origin decides where session cookies and tokens are sent, so the page
  // re-applies the host's policy instead of inheriting the decision.
  it.each([
    'https://evil.example/path',
    'https://evil.example/?token=abc',
    'https://evil.example/#/settings',
    'https://user:secret@evil.example',
    'http://evil.example',
    'not-a-url',
  ])('rejects a report carrying the unsafe origin %s', async (apiOrigin) => {
    const runtime = await loadRuntime({ ...validBoot(), apiOrigin });

    expect(runtime.readDesktopBootReport()).toBeNull();
  });

  it.each(['https://bettrcomms-production.up.railway.app', 'http://localhost:5173', ''])(
    'accepts the safe origin %s',
    async (apiOrigin) => {
      const runtime = await loadRuntime({ ...validBoot(), apiOrigin });

      expect(runtime.readDesktopBootReport()).not.toBeNull();
    },
  );

  it('surfaces a host origin failure instead of hiding it', async () => {
    const runtime = await loadRuntime({
      ...validBoot(),
      apiOrigin: '',
      apiOriginError: 'BETTERCOMMS_API_ORIGIN is required in production builds',
    });

    expect(runtime.getDesktopApiOrigin()).toBeNull();
    expect(runtime.readDesktopBootReport()?.apiOriginError).toContain(
      'required in production builds',
    );
  });
});
