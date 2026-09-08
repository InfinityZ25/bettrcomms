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
    const otherRoom = (await json<{ room: Room }>(await context.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: 'Browse without leaving' },
    }))).room;
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: room.name }).click();
    await page.getByRole('button', { name: 'Join call' }).click();
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();

    await page.getByRole('button', { name: otherRoom.name }).click();
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(page.locator('.room-heading strong')).toHaveText(otherRoom.name);
    await page.getByRole('button', { name: `Return to ${room.name}` }).click();

    const stage = page.locator('.call-workspace .stage');
    await expect(stage).toHaveAttribute('data-has-share', 'false');
    await expect(stage).toHaveAttribute('data-gallery', 'adaptive');
    const galleryLayout = page.getByLabel('Call layout', { exact: true });
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
    expect(soloTileBox.width / soloTileBox.height).toBeCloseTo(16 / 9, 1);
    expect(soloTileBox.height).toBeGreaterThan(stageBoxBeforeShare.height * .65);
    await page.getByRole('button', { name: 'Turn on camera' }).click();
    const cameraVideo = page.locator('.camera-tile.self video');
    await expect.poll(() => cameraVideo.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    const sourceAspect = await cameraVideo.evaluate((video: HTMLVideoElement) => video.videoWidth / video.videoHeight);
    const tileAspect = await page.locator('.camera-tile.self').evaluate(element => Number(getComputedStyle(element).getPropertyValue('--media-aspect')));
    expect(tileAspect).toBeCloseTo(sourceAspect, 2);
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

    const zoomOut = page.getByRole('button', { name: 'Zoom out Your screen' });
    const resetZoom = page.getByRole('button', { name: 'Reset zoom Your screen' });
    for (let step = 0; step < 6; step += 1) await zoomOut.click();
    await expect(resetZoom).toHaveText('50%');
    await resetZoom.click();
    const viewport = page.locator('.stage-content-pane .video-viewport');
    const viewportBox = await viewport.boundingBox();
    if (!viewportBox) throw new Error('Shared content viewport has no layout box');
    await page.mouse.move(viewportBox.x + viewportBox.width * .75, viewportBox.y + viewportBox.height * .4);
    await page.mouse.wheel(0, -240);
    await expect(resetZoom).toHaveText(/1[2-9]\d%|[2-5]\d\d%/);
    const transformBeforePan = await page.locator('.stage-content-pane .zoom-surface').evaluate(element => getComputedStyle(element).transform);
    await page.mouse.down();
    await page.mouse.move(viewportBox.x + viewportBox.width * .6, viewportBox.y + viewportBox.height * .55, { steps: 5 });
    await page.mouse.up();
    const transformAfterPan = await page.locator('.stage-content-pane .zoom-surface').evaluate(element => getComputedStyle(element).transform);
    expect(transformAfterPan).not.toBe(transformBeforePan);
    await resetZoom.click();

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
    await expect.poll(() => page.locator('.call-workspace').evaluate(element => ({
      horizontal: element.scrollWidth - element.clientWidth,
      vertical: element.scrollHeight - element.clientHeight,
    }))).toEqual({ horizontal: 0, vertical: 0 });
    await expect(page.locator('.call-workspace')).toHaveAttribute('data-controls-visible', 'false', { timeout: 4000 });
    const fullscreenStageBox = await stage.boundingBox();
    expect(fullscreenStageBox?.height).toBeGreaterThan(880);
    await page.waitForTimeout(220);
    await page.screenshot({ path: '.local/call-layout-fullscreen.png', fullPage: true });
    await page.mouse.move(20, 450);
    await expect(page.locator('.call-workspace')).toHaveAttribute('data-controls-visible', 'true');
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

    await page.setViewportSize({ width: 1280, height: 900 });
    await galleryLayout.selectOption('all');
    await expect(stage).toHaveAttribute('data-gallery', 'all');
    await expect(stage).toHaveAttribute('data-has-share', 'false');
    const shareTile = page.locator('.screen-share-tile');
    await expect(shareTile).toBeVisible();
    await expect(shareTile.locator('video')).toBeVisible();
    await shareTile.hover();
    await page.getByRole('button', { name: 'Stop watching Your screen' }).click();
    const frozenPreview = shareTile.locator('.frozen-track-preview');
    await expect(frozenPreview).toHaveAttribute('data-preview-ready', 'true');
    expect(await frozenPreview.locator('canvas').evaluate((canvas: HTMLCanvasElement) => ({ width: canvas.width, height: canvas.height }))).toEqual({ width: 640, height: 360 });
    await expect(page.getByRole('button', { name: 'Watch Your screen' })).toBeVisible();
    // The still frame is the only painted surface, but the track stays attached
    // and playing. Detaching it would make resuming wait for a fresh keyframe,
    // and a native sender cannot produce one on request.
    const offscreen = frozenPreview.locator('video');
    await expect(offscreen).toHaveCount(1);
    expect(await offscreen.evaluate((video: HTMLVideoElement) => ({
      paused: video.paused,
      attached: video.srcObject !== null,
      opacity: getComputedStyle(video).opacity,
    }))).toEqual({ paused: false, attached: true, opacity: '0' });
    const framesWhileFrozen = () => offscreen.evaluate((video: HTMLVideoElement) =>
      video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0);
    const beforeFreeze = await framesWhileFrozen();
    await expect.poll(framesWhileFrozen).toBeGreaterThan(beforeFreeze);
    await page.screenshot({ path: '.local/call-layout-all-media.png', fullPage: true });
    // Resuming paints live video again without a decoder restart.
    await page.getByRole('button', { name: 'Watch Your screen' }).click();
    await expect(frozenPreview).toHaveCount(0);
    await expect.poll(() => shareTile.locator('video').first().evaluate(
      (video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  } finally {
    await context.close();
  }
});
