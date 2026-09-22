import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/core', () => mocks);

const TOKEN = 'x'.repeat(43);

function capability(state = 'unavailable') {
  return { state, detail: 'detail', fallback: 'browser path' };
}

function validBoot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runtime: 'wails',
    hostVersion: '0.0.1-wails',
    platform: 'windows',
    architecture: 'amd64',
    apiOrigin: 'https://app.example.test',
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
    ...extra,
  };
}

const packaged = () => validBoot({ apiBase: 'http://127.0.0.1:52341', apiToken: TOKEN });

async function loadTransport(boot?: unknown) {
  vi.resetModules();
  vi.stubGlobal(
    'window',
    boot === undefined ? {} : { __BETTERCOMMS_DESKTOP__: boot },
  );
  vi.stubGlobal('location', { href: 'https://app.example.test/' });
  return import('./apiTransport');
}

describe('API transport', () => {
  beforeEach(() => {
    mocks.isTauri.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  it('leaves same-origin hosts alone', async () => {
    const transport = await loadTransport();

    expect(transport.apiHttpUrl('/api/v1/me')).toBe('/api/v1/me');
    expect(transport.apiAuthHeaders()).toEqual({});
    // Same-origin, the session cookie is the whole authentication.
    expect(transport.apiCredentials()).toBe('include');
    expect(transport.apiSocketUrl('/api/v1/events')).toBe(
      'wss://app.example.test/api/v1/events',
    );
  });

  it('routes a packaged host through its loopback proxy', async () => {
    const transport = await loadTransport(packaged());

    expect(transport.apiHttpUrl('/api/v1/me')).toBe(
      'http://127.0.0.1:52341/api/v1/me',
    );
    expect(transport.apiAuthHeaders()).toEqual({
      Authorization: 'Bearer ' + TOKEN,
    });
  });

  // The proxy accepts no credentials and so answers no
  // Access-Control-Allow-Credentials. A credentialed cross-origin request is
  // then refused by the browser before it is sent — which is not a CORS detail
  // but the difference between an application that can reach its API and one
  // that silently cannot. The page holds no cookies for that origin anyway: the
  // session is in the host process, which is why the proxy exists.
  it('sends no cookies through the loopback proxy', async () => {
    const transport = await loadTransport(packaged());

    expect(transport.apiCredentials()).toBe('omit');
  });

  it('carries the launch token on WebSockets, which cannot send headers', async () => {
    const transport = await loadTransport(packaged());

    const url = new URL(transport.apiSocketUrl('/api/v1/rooms/7/ws?peer_id=abc'));
    expect(url.protocol).toBe('ws:');
    expect(url.host).toBe('127.0.0.1:52341');
    expect(url.searchParams.get('peer_id')).toBe('abc');
    expect(url.searchParams.get('__bc_token')).toBe(TOKEN);
  });

  it('never hands the launch token to another origin', async () => {
    const transport = await loadTransport(packaged());

    const url = new URL(transport.apiSocketUrl('wss://elsewhere.example/socket'));
    expect(url.host).toBe('elsewhere.example');
    expect(url.searchParams.has('__bc_token')).toBe(false);
  });

  it('rejects a boot report whose proxy base is not loopback', async () => {
    // A non-loopback base would send every request and its session off the
    // machine, to somewhere the origin policy never approved.
    const transport = await loadTransport(
      validBoot({ apiBase: 'http://attacker.example', apiToken: TOKEN }),
    );

    expect(transport.apiHttpUrl('/api/v1/me')).toBe('/api/v1/me');
    expect(transport.apiAuthHeaders()).toEqual({});
  });

  it.each([
    ['a base with no token', { apiBase: 'http://127.0.0.1:52341' }],
    ['a token with no base', { apiToken: TOKEN }],
    ['a token that is too short', { apiBase: 'http://127.0.0.1:52341', apiToken: 'short' }],
    [
      'a token carrying a query delimiter',
      { apiBase: 'http://127.0.0.1:52341', apiToken: TOKEN + '&role=admin' },
    ],
    [
      'a base carrying a path',
      { apiBase: 'http://127.0.0.1:52341/proxy', apiToken: TOKEN },
    ],
  ])('discards a report with %s', async (_name, extra) => {
    const transport = await loadTransport(validBoot(extra));

    expect(transport.apiHttpUrl('/api/v1/me')).toBe('/api/v1/me');
    expect(transport.apiAuthHeaders()).toEqual({});
  });

  it('refuses a socket path that is not http(s) or ws(s)', async () => {
    const transport = await loadTransport();

    expect(() => transport.apiSocketUrl('ftp://example.test/socket')).toThrow(
      TypeError,
    );
  });
});
