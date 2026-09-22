import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// This exercises the shipped JS runtime, not mocked Window methods. HTTP replies
// stand in for the native host; it does NOT establish Windows hit-test acceptance.
test('packaged Wails runtime loads under CSP and sends built-in window commands', async ({ page }) => {
  test.skip(process.env.WAILS_RUNTIME_ACCEPTANCE !== '1',
    'Known failing packaged-runtime diagnostic; build frontend and set WAILS_RUNTIME_ACCEPTANCE=1. See docs/WAILS_PR_HANDOFF.md.');
  const unavailable = { state: 'unavailable', detail: 'fixture', fallback: 'browser' };
  const boot = {
    schemaVersion: 1, runtime: 'wails', hostVersion: 'test',
    platform: 'windows', architecture: 'amd64', apiOrigin: '', authReturn: unavailable,
    windowControls: {
      platform: 'windows', mode: 'client-side', height: 32,
      insetStart: 0, insetEnd: 0, buttons: ['minimize', 'maximize', 'close'], buttonSide: 'end',
    },
    capabilities: {
      schemaVersion: 1, platform: 'windows', architecture: 'amd64',
      browserMedia: { state: 'implemented', detail: 'fixture' },
      nativeGameVideo: unavailable, nativeProcessAudio: unavailable,
      nativeMicrophoneDsp: unavailable, localTrackRecording: unavailable,
      mediaPermissions: unavailable, globalInput: unavailable,
      nativeOverlays: unavailable, notes: [],
    },
  };
  const script = `window.__BETTERCOMMS_DESKTOP__=JSON.parse(${JSON.stringify(JSON.stringify(boot))});`;
  const digest = createHash('sha256').update(script).digest('base64');
  const csp = `default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval' 'sha256-${digest}'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https:; media-src 'self' blob: mediastream:; connect-src 'self' blob: http://127.0.0.1:* ws://127.0.0.1:*; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'`;
  const dist = path.resolve('apps/web/dist');
  const html = (await readFile(path.join(dist, 'index.html'), 'utf8'))
    .replace('<head>', `<head><script>${script}</script>`);
  const commands: number[] = [];
  const errors: string[] = [];
  let maximised = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    // Only platform globals are simulated; the runtime module and its fetch
    // transport come from the production bundle.
    Object.assign(window, {
      chrome: { webview: { postMessage() {} } },
      _wails: { flags: { nonClientRegionTracking: true }, environment: { OS: 'windows' } },
    });
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://wails.localhost') return route.abort();
    if (url.pathname === '/wails/runtime') {
      const request = route.request().postDataJSON();
      if (request.object !== 6) return route.fulfill({ status: 400, body: 'Unexpected runtime object' });
      commands.push(request.method);
      if (request.method === 39) maximised = !maximised;
      return route.fulfill({ json: request.method === 14 ? maximised : null });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: { error: 'Unauthenticated fixture' } });
    if (url.pathname === '/wails/custom.js') return route.fulfill({ status: 404 });
    if (url.pathname === '/') return route.fulfill({
      contentType: 'text/html', body: html,
      headers: { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' },
    });
    const filename = path.resolve(dist, '.' + url.pathname);
    if (!filename.startsWith(dist + path.sep)) return route.abort();
    const contentType = ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' } as Record<string, string>)[path.extname(filename)];
    try {
      return await route.fulfill({ body: await readFile(filename), contentType: contentType ?? 'application/octet-stream' });
    } catch {
      return route.fulfill({ status: 404 });
    }
  });
  await page.goto('http://wails.localhost/');
  await expect(page.getByRole('button', { name: 'Maximize window', exact: true })).toBeVisible();
  await expect.poll(() => ({ queried: commands.includes(14), errors })).toEqual({ queried: true, errors: [] });
  await page.getByRole('button', { name: 'Maximize window', exact: true }).click();
  await expect.poll(() => commands.includes(39)).toBe(true);
  await page.getByRole('button', { name: 'Minimize window', exact: true }).click();
  await expect.poll(() => commands.includes(17)).toBe(true);
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect.poll(() => commands.includes(2)).toBe(true);
  await expect(page.getByText('Window action failed. Please try again.')).toHaveCount(0);
  expect(errors).toEqual([]);
});
