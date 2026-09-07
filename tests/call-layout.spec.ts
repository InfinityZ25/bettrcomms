import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';

type User = { id: string; name: string };
type Room = { id: string; name: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()} ${response.url()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = await json<User | { user: User }>(await context.request.post('/api/v1/auth/dev', {
    headers: { Origin: origin }, data: { name: 'Layout Ada', email: `layout-${suffix}@example.test` },
  }));
  return 'user' in body ? body.user : body;
}

const installSyntheticDisplay = () => {
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      const graphics = canvas.getContext('2d')!;
      let frame = 0;
      const paint = () => {
        graphics.fillStyle = frame++ % 2 ? '#4467e8' : '#20a477';
        graphics.fillRect(0, 0, canvas.width, canvas.height);
        graphics.fillStyle = '#fff'; graphics.font = '44px sans-serif';
        graphics.fillText('Layout preview', 145, 190);
      };
      paint();
      const timer = setInterval(paint, 80);
      const stream = canvas.captureStream(12);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => clearInterval(timer), { once: true });
      return stream;
    },
  });
};

test('camera dock resizes, snaps, focuses, and preserves the active share', async ({ browser }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  await context.addInitScript(installSyntheticDisplay);
  try {
    await login(context);
    const room = (await json<{ room: Room }>(await context.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: 'Layout studio' },
    }))).room;
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: room.name }).click();
    await page.getByRole('button', { name: 'Join call' }).click();
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();

    const stage = page.locator('.call-workspace .stage');
    await expect(stage).toHaveAttribute('data-has-share', 'false');
    await expect(stage).toHaveAttribute('data-gallery', 'adaptive');
    const galleryLayout = page.getByLabel('Camera gallery layout');
    await galleryLayout.selectOption('grid');
    await expect(stage).toHaveAttribute('data-gallery', 'grid');
    expect(await page.evaluate(() => localStorage.getItem('bc-gallery-layout'))).toBe('grid');
    const fit = page.getByRole('button', { name: 'Fill tiles' });
    await fit.click();
    await expect(stage).toHaveAttribute('data-camera-fit', 'contain');
    expect(await page.evaluate(() => localStorage.getItem('bc-gallery-fit'))).toBe('contain');
    const stageBoxBeforeShare = await stage.boundingBox();
    const soloTileBox = await page.locator('.camera-tile.self').boundingBox();
    if (!stageBoxBeforeShare || !soloTileBox) throw new Error('Gallery has no layout box');
    expect(soloTileBox.height).toBeGreaterThan(stageBoxBeforeShare.height * .8);
    await page.screenshot({ path: '.local/call-gallery-desktop.png', fullPage: true });

    await page.getByRole('button', { name: 'Share screen' }).click();

    const sharedVideo = page.locator('.content-stage video');
    await expect(stage).toHaveAttribute('data-has-share', 'true');
    await expect(sharedVideo).toBeVisible();
    await expect.poll(() => sharedVideo.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    const originalTrackId = await sharedVideo.evaluate((video: HTMLVideoElement) =>
      (video.srcObject as MediaStream).getVideoTracks()[0]?.id,
    );
    expect(originalTrackId).toBeTruthy();

    const position = page.getByLabel('Camera position');
    for (const [label, dock] of [['Top row', 'top'], ['Left side', 'left'], ['Right side', 'right']] as const) {
      await position.selectOption({ label });
      await expect(stage).toHaveAttribute('data-dock', dock);
      await expect(sharedVideo).toBeVisible();
      expect(await sharedVideo.evaluate((video: HTMLVideoElement) =>
        (video.srcObject as MediaStream).getVideoTracks()[0]?.id,
      )).toBe(originalTrackId);
    }

    await position.selectOption('top');
    const divider = page.getByRole('separator', { name: 'Resize cameras' });
    const before = Number(await divider.getAttribute('aria-valuenow'));
    const dividerBox = await divider.boundingBox();
    if (!dividerBox) throw new Error('Camera divider has no layout box');
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
    await page.mouse.down(); await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 72); await page.mouse.up();
    const resized = Number(await divider.getAttribute('aria-valuenow'));
    const minimum = Number(await divider.getAttribute('aria-valuemin'));
    const maximum = Number(await divider.getAttribute('aria-valuemax'));
    expect(resized).toBeGreaterThan(before);
    expect(resized).toBeGreaterThanOrEqual(minimum); expect(resized).toBeLessThanOrEqual(maximum);
    expect(Number(await page.evaluate(() => localStorage.getItem('bc-camera-row-size')))).toBe(resized);

    const handle = page.getByRole('button', { name: 'Drag cameras to dock' });
    const handleBox = await handle.boundingBox(); const stageBox = await stage.boundingBox();
    if (!handleBox || !stageBox) throw new Error('Camera drag controls have no layout box');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(stageBox.x + stageBox.width - 12, stageBox.y + stageBox.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(stage).toHaveAttribute('data-dock', 'right');
    await expect(position).toHaveValue('right');

    await page.screenshot({ path: '.local/call-layout-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'Fullscreen call' }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('call-workspace'))).toBe(true);
    await expect(page.locator('.call-workspace .camera-dock')).toBeVisible();
    await expect(page.locator('.call-workspace .call-controls')).toBeVisible();
    await page.screenshot({ path: '.local/call-layout-fullscreen.png', fullPage: true });
    await page.getByRole('button', { name: 'Exit fullscreen call' }).click();

    await page.getByRole('button', { name: 'Focus call' }).click();
    await expect(page.locator('.app-shell')).toHaveClass(/is-call-focused/);
    await expect(page.locator('.space-rail')).toBeHidden();
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.getByRole('button', { name: 'Show navigation' }).click();
    await expect(page.locator('.app-shell')).not.toHaveClass(/is-call-focused/);

    await page.setViewportSize({ width: 390, height: 844 });
    const closeChat = page.getByRole('button', { name: 'Close chat' });
    if (await closeChat.isVisible()) await closeChat.click();
    await expect(stage).toHaveAttribute('data-dock', 'right');
    const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    expect(overflow.document).toBeLessThanOrEqual(overflow.viewport);
    expect(await sharedVideo.evaluate((video: HTMLVideoElement) =>
      (video.srcObject as MediaStream).getVideoTracks()[0]?.id,
    )).toBe(originalTrackId);
    await page.screenshot({ path: '.local/call-layout-mobile.png', fullPage: true });
  } finally {
    await context.close();
  }
});
