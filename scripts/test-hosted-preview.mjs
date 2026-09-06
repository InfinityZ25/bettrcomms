// Read-only production smoke: does not create users, sessions, rooms, or media.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = process.env.BETTERCOMMS_HOSTED_ORIGIN ?? 'https://bettrcomms-production.up.railway.app';
assert.equal(new URL(origin).protocol, 'https:');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-security-policy'], /object-src 'none'/);
  await page.getByRole('button', { name: /Continue with WorkOS/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Enter local workspace' }).count(), 0);
  const config = await page.request.get(`${origin}/api/v1/config`);
  assert.equal((await config.json()).dev_auth, false);
  const me = await page.request.get(`${origin}/api/v1/me`);
  assert.equal(me.status(), 401);
  const relay = await page.request.get(`${origin}/api/v1/rooms/00000000-0000-4000-8000-000000000001/voice-relay`);
  assert.equal(relay.status(), 401);
  const worklet = await page.request.get(`${origin}/voicePlayback.worklet.js`);
  assert.equal(worklet.status(), 200);
  assert.match(await worklet.text(), /bettercomms-voice-playback/);
  await mkdir('.local/hosted-smoke', { recursive: true });
  await page.screenshot({ path: '.local/hosted-smoke/home.png', fullPage: true });
  await page.goto(`${origin}/#/settings`);
  await page.getByLabel(/^Voice route/).waitFor();
  await page.goto(origin);
  await page.getByRole('button', { name: /Continue with WorkOS/ }).click();
  await page.waitForURL(url => url.hostname.endsWith('.authkit.app') || url.hostname === 'api.workos.com', { timeout: 30_000 });
  await page.waitForLoadState('domcontentloaded');
  // Never log the OAuth URL: it carries a state nonce.
  console.log(JSON.stringify({ origin, appRendered: true, devAuthDisabled: true, unauthenticatedApiRejected: true, loginHost: new URL(page.url()).hostname, pageErrors: errors }));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
