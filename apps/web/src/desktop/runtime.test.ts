import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBootReport } from './types';

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
    vi.unstubAllGlobals();
  });

  it('detects the Wails host from its injected boot report', async () => {
    const runtime = await loadRuntime(validBoot());

    expect(runtime.getDesktopRuntime()).toBe('wails');
    expect(runtime.isDesktopShell()).toBe(true);
    expect(runtime.getDesktopApiOrigin()).toBe('http://127.0.0.1:8080');
  });

  it.each(['ios', 'android'])('accepts the %s host without desktop window controls', async (platform) => {
    const boot = validBoot();
    boot.platform = platform;
    boot.windowControls = {
      platform, mode: 'native-frame', height: 0,
      insetStart: 0, insetEnd: 0, buttons: [], buttonSide: 'end',
    };
    const runtime = await loadRuntime(boot);

    expect(runtime.readDesktopBootReport()?.windowControls).toEqual(boot.windowControls);
  });

  it('reports a browser when no host is present', async () => {
    const runtime = await loadRuntime();

    expect(runtime.getDesktopRuntime()).toBe('browser');
    expect(runtime.isDesktopShell()).toBe(false);
  });

});

describe('desktop boot report validation', () => {
  beforeEach(() => {
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
    ['a wrong runtime name', { ...validBoot(), runtime: 'unknown' }],
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

it('preserves the Android flavor capability and rejects malformed SDK reports', async () => {
  const boot = validBoot();
  boot.platform = 'android';
  boot.capabilities = { ...(boot.capabilities as object), nativeMetaCamera: capability('experimental') };
  let runtime = await loadRuntime(boot);
  expect(runtime.readDesktopBootReport()?.capabilities.nativeMetaCamera?.state).toBe('experimental');
  boot.capabilities = { ...(boot.capabilities as object), nativeMetaCamera: { state: 'pretend' } };
  runtime = await loadRuntime(boot);
  expect(runtime.readDesktopBootReport()).toBeNull();
});
