import { test, expect, type BrowserContext, type Page, type APIResponse } from '@playwright/test';
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const headers = { Origin: new URL(baseURL).origin };
async function json(response: APIResponse) { expect(response.ok(), `API status ${response.status()}`).toBeTruthy(); return response.json(); }
async function login(context: BrowserContext, name: string) {
  const deadline = Date.now() + 65_000;
  let response: APIResponse;
  do {
    response = await context.request.post('/api/v1/auth/dev', { headers, data: { name, email: `copilot-${name}-${crypto.randomUUID()}@example.test` } });
    if (response.status() !== 429 || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  } while (true);
  const result = await json(response);
  return result.user ?? result;
}
async function enable(page: Page) {
  await page.getByRole('button', { name: 'Audio and video settings' }).click();
  await page.getByRole('checkbox', { name: 'Enable visual copilot on this device' }).check();
}
function syntheticScreen() {
  if (!navigator.mediaDevices) return;
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d')!;
    const paint = () => { ctx.fillStyle = (window as any).copilotFixtureColor ?? '#087e35'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#fff'; ctx.fillRect(310, 170, 20, 20); };
    paint(); const timer = setInterval(paint, 50); const stream = canvas.captureStream(20);
    stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer), { once: true }); return stream;
  } });
}

test('settings are opt-in, persist and reject push-to-talk shortcut conflicts', async ({ page, context }) => {
  await login(context, 'Settings');
  await page.goto('/');
  await page.getByRole('button', { name: 'Audio and video settings' }).click();
  await expect(page.getByRole('checkbox', { name: 'Enable visual copilot on this device' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Enable visual copilot on this device' }).check();
  await page.getByLabel('Signal duration').selectOption('4');
  await page.getByLabel('Capture corner').selectOption('bottom-left');
  await page.getByLabel('Point shortcut').selectOption('KeyP');
  await page.getByLabel('Freeze shortcut').selectOption('KeyP');
  await expect(page.getByRole('alert')).toContainText('different shortcuts');
  await page.getByRole('checkbox', { name: 'Push-to-talk', exact: true }).check();
  await page.getByRole('button', { name: 'Set push-to-talk shortcut' }).click(); await page.keyboard.press('g');
  await page.getByLabel('Point shortcut').selectOption('KeyG');
  await expect(page.getByRole('alert')).toContainText('push-to-talk');
  await page.reload();
  await expect(page.getByLabel('Signal duration')).toHaveValue('4');
  await expect(page.getByLabel('Point shortcut')).toHaveValue('KeyP');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Visual copilot' }).scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/copilot-settings-mobile.png', fullPage: true });
});

test('two participants point, freeze a frame, receive its marked capture and revoke permission without interrupting media', async ({ browser }) => {
  const a = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  const b = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  await a.addInitScript(syntheticScreen);
  try {
    await login(a, 'Owner'); const guest = await login(b, 'Viewer');
    const friendship = await json(await a.request.post('/api/v1/friends/requests', { headers, data: { user_id: guest.id } }));
    await json(await b.request.post(`/api/v1/friends/requests/${friendship.request.id}/accept`, { headers, data: {} }));
    const { room } = await json(await a.request.post('/api/v1/rooms', { headers, data: { name: 'Copilot acceptance' } }));
    await json(await a.request.post(`/api/v1/rooms/${room.id}/members`, { headers, data: { user_id: guest.id } }));
    const owner = await a.newPage(), viewer = await b.newPage();
    owner.setDefaultTimeout(15_000); viewer.setDefaultTimeout(15_000);
    await owner.goto('/'); await viewer.goto('/');
    for (const page of [owner, viewer]) {
      await enable(page);
      await page.getByRole('button', { name: room.name }).click();
      await page.getByRole('button', { name: 'Join call', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
    }
    await owner.getByRole('button', { name: 'Share screen', exact: true }).click();
    await viewer.getByRole('button', { name: 'Watch Owner' }).click();
    const video = viewer.locator('.stage-content-pane video');
    // WebRTC may adapt the synthetic source under load; mark the decoded frame.
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    await expect(viewer.getByRole('button', { name: 'Point', exact: true })).toBeDisabled();
    await owner.locator('.copilot-permissions summary').click();
    await owner.getByRole('checkbox', { name: 'Allow signals from Viewer' }).check();
    await owner.getByRole('checkbox', { name: 'Allow captures from Viewer' }).check();
    const localVideo = owner.locator('.stage-content-pane video');
    const trackId = await localVideo.evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0].id);
    await viewer.getByRole('button', { name: 'Point', exact: true }).click();
    await viewer.locator('.copilot-pointer-surface').click({ position: { x: 200, y: 130 } });
    await expect(owner.locator('.copilot-local-marks circle')).toHaveCount(1);
    await expect(viewer.locator('.copilot-toolbar [role=status]')).toContainText('Received by the sharer.');
    await expect(viewer.locator('.copilot-sent-point')).toBeVisible();
    await expect(owner.locator('.copilot-local-marks circle')).toHaveCount(0, { timeout: 6000 });
    await viewer.getByRole('button', { name: 'Laser', exact: true }).click();
    const surface = (await viewer.locator('.copilot-pointer-surface').boundingBox())!;
    await viewer.mouse.move(surface.x + surface.width * .4, surface.y + surface.height * .4);
    await viewer.mouse.down();
    await expect(owner.locator('.copilot-local-marks circle')).toHaveCount(1);
    const initialPosition = await owner.locator('.copilot-local-marks g').getAttribute('transform');
    // A quick drag must retain its last position even inside the send throttle.
    await viewer.mouse.move(surface.x + surface.width * .6, surface.y + surface.height * .6);
    await expect(owner.locator('.copilot-local-marks g')).not.toHaveAttribute('transform', initialPosition!);
    await viewer.mouse.up();
    await expect(owner.locator('.copilot-local-marks circle')).toHaveCount(1);
    await expect(owner.locator('.copilot-local-marks circle')).toHaveCount(0, { timeout: 6000 });
    await viewer.getByRole('button', { name: 'Freeze & mark', exact: true }).click();
    const frozen = await viewer.locator('.copilot-frozen').getAttribute('src');
    await owner.evaluate(() => { (window as any).copilotFixtureColor = '#b71522'; });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d')!; x.drawImage(v, 0, 0); return x.getImageData(10, 10, 1, 1).data[0]; })).toBeGreaterThan(120);
    expect(await viewer.locator('.copilot-frozen').getAttribute('src')).toBe(frozen);
    await viewer.locator('.copilot-pointer-surface').click({ position: { x: 200, y: 140 } });
    await viewer.getByRole('button', { name: 'Send marked capture' }).click();
    const image = owner.getByRole('img', { name: 'Frame marked by Viewer' });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d')!; x.drawImage(img, 0, 0); return [...x.getImageData(10, 10, 1, 1).data]; })).toEqual(expect.arrayContaining([expect.any(Number)]));
    const color = await image.evaluate((img: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d')!; x.drawImage(img, 0, 0); return [...x.getImageData(10, 10, 1, 1).data]; });
    expect(color[1]).toBeGreaterThan(color[0] * 2);
    await owner.screenshot({ path: '.local/copilot-received-capture.png', fullPage: true });
    expect(await localVideo.evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0].id)).toBe(trackId);
    await owner.getByRole('button', { name: 'Pause all indications' }).click();
    await expect(image).not.toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Point', exact: true })).toBeDisabled();
    await expect(viewer.getByRole('button', { name: 'Freeze & mark', exact: true })).toBeDisabled();
    await expect(owner.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await owner.getByRole('checkbox', { name: 'Allow signals from Viewer' }).check();
    await owner.getByRole('button', { name: 'Stop sharing', exact: true }).click();
    await owner.getByRole('button', { name: 'Share screen', exact: true }).click();
    await owner.locator('.copilot-permissions summary').click();
    await expect(owner.getByRole('checkbox', { name: 'Allow signals from Viewer' })).not.toBeChecked();
  } finally { await a.close().catch(() => {}); await b.close().catch(() => {}); }
});
