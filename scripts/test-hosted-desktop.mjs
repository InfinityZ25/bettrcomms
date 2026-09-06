// Opt-in packaged desktop smoke. The caller launches the release executable with
// an isolated WebView2 profile and loopback CDP port before running this script.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const endpoint = process.env.BETTERCOMMS_RELEASE_CDP ?? 'http://127.0.0.1:9224';
const expectedOrigin = process.env.BETTERCOMMS_RELEASE_ORIGIN
  ?? 'https://bettrcomms-production.up.railway.app';
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = await (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const candidate = browser.contexts().flatMap(context => context.pages())[0];
      if (candidate && candidate.url().startsWith(expectedOrigin)) return candidate;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Packaged hosted page did not appear');
  })();
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error')
      consoleErrors.push(message.text().replace(/https?:\/\/[^\s?#]+[^\s]*/g, '[redacted-url]'));
  });
  await page.waitForLoadState('domcontentloaded');
  assert.equal(new URL(page.url()).origin, expectedOrigin);
  await page.getByRole('button', { name: /Continue with WorkOS/i }).waitFor({ timeout: 20_000 });
  const result = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error('Tauri IPC bridge is missing');
    const [boot, screen, media] = await Promise.all([
      invoke('desktop_boot_config'),
      invoke('native_screen_capabilities'),
      invoke('desktop_media_capabilities'),
    ]);
    return {
      boot,
      screen: { available: screen.available, version: screen.version },
      media,
      mediaDevices: Boolean(navigator.mediaDevices),
    };
  });
  assert.equal(result.boot.apiOrigin, expectedOrigin);
  assert.equal(result.boot.schemaVersion, 1);
  assert.equal(result.screen.version, 1);
  assert.equal(result.media.platform, 'windows');
  assert.equal(result.mediaDevices, true);

  await page.getByRole('button', { name: /Continue with WorkOS/i }).click();
  await page.waitForURL(url => url.origin !== expectedOrigin, { timeout: 20_000 });
  const authHost = new URL(page.url()).hostname;
  assert.ok(authHost === 'api.workos.com' || authHost.endsWith('.authkit.app'),
    `Unexpected authentication host: ${authHost}`);
  const rejection = await page.evaluate(async () => {
    if (!window.__TAURI_INTERNALS__?.invoke) return 'bridge-not-exposed';
    try {
      await window.__TAURI_INTERNALS__.invoke('desktop_media_capabilities');
      return 'unexpected-success';
    } catch (error) {
      return String(error);
    }
  });
  assert.notEqual(rejection, 'unexpected-success', 'External authentication pages must not invoke native commands');
  console.log('PASS packaged hosted desktop', JSON.stringify({
    origin: expectedOrigin,
    nativeScreenAvailable: result.screen.available,
    mediaDevices: result.mediaDevices,
    authHost,
    externalIpc: rejection === 'bridge-not-exposed' ? rejection : 'rejected',
    consoleErrorCount: consoleErrors.length,
    consoleErrors: consoleErrors.slice(0, 5),
  }));
} finally {
  await browser.close();
}
