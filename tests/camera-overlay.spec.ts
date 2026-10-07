import { test, expect } from '@playwright/test';

test('overlay composites cameras without capturing devices or stopping source tracks', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { CameraOverlayCanvas } =
      await import('/src/media/cameraOverlayCanvas.ts');
    const source = document.createElement('canvas');
    source.width = 160;
    source.height = 90;
    const graphics = source.getContext('2d')!;
    graphics.fillStyle = '#ff0000';
    graphics.fillRect(0, 0, 160, 90);
    const stream = source.captureStream(10);
    const track = stream.getVideoTracks()[0];
    const overlay = new CameraOverlayCanvas();
    const cameras = [{ id: 'friend', name: 'Friend', track }];
    overlay.render(cameras, 240, 135);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const frame = overlay.render(cameras, 240, 135);
    const offset = (60 * 240 + 120) * 4;
    const pixel = Array.from(frame.slice(offset, offset + 4));
    track.enabled = false;
    const hidden = overlay.render(cameras, 240, 135);
    const hiddenPixel = Array.from(hidden.slice(offset, offset + 4));
    overlay.dispose();
    const state = track.readyState;
    track.stop();
    return { bytes: frame.byteLength, pixel, hiddenPixel, state };
  });
  expect(result.bytes).toBe(240 * 135 * 4);
  expect(result.pixel).toEqual([255, 0, 0, 255]);
  expect(result.hiddenPixel).not.toEqual(result.pixel);
  expect(result.state).toBe('live');
});

test('resizing a call keeps its native overlay running until the call ends', async ({
  page,
}) => {
  // Mock only the Windows native boundary. The real React call stage, canvas,
  // API and database still run; this does not prove a Windows overlay display.
  for (const [path, original, replacement] of [
    [
      'desktop/nativeMedia',
      'return getDesktopRuntime() !== "browser";',
      'return true;',
    ],
    [
      'media/permissions',
      'return await desktopPlatform() === "windows";',
      'return true;',
    ],
  ]) {
    await page.route(`**/src/${path}.ts*`, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      expect(body).toContain(original);
      await route.fulfill({
        response,
        body: body.replace(original, replacement),
      });
    });
  }
  await page.addInitScript(() => {
    Object.assign(window, { __overlay: { opened: 0, closed: 0, frames: 0 } });
  });
  await page.route('**/src/desktop/cameraOverlay.ts*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `const session = {overlayId:'fixture',width:160,height:90,maxFps:10};
export async function openCameraOverlay() { window.__overlay.opened++; return session; }
export async function updateCameraOverlay() { return session; }
export async function sendCameraOverlayFrame() { window.__overlay.frames++; }
export async function closeCameraOverlay() { window.__overlay.closed++; }`,
    }),
  );
  const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:5173')
    .origin;
  const response = await page.request.post('/api/v1/auth/dev', {
    headers: { Origin: origin },
    data: {
      name: 'Overlay Resize',
      email: `overlay-resize-${crypto.randomUUID()}@example.test`,
    },
  });
  expect(response.ok()).toBe(true);
  const roomResponse = await page.request.post('/api/v1/rooms', {
    headers: { Origin: origin },
    data: { name: 'Overlay resize call' },
  });
  expect(roomResponse.ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Join voice', exact: true }).click();
  await page.locator('.call-footer').hover();
  await page.locator('.camera-overlay-controls summary').click();
  await page.getByRole('button', { name: 'Show camera overlay' }).click();
  const counters = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __overlay: { opened: number; closed: number; frames: number };
          }
        ).__overlay,
    );
  await expect.poll(async () => (await counters()).frames).toBeGreaterThan(2);
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(
    page.getByRole('button', { name: 'More call options' }),
  ).toBeVisible();
  await expect(page.locator('.call-chrome-actions')).toBeHidden();
  const before = (await counters()).frames;
  await expect
    .poll(async () => (await counters()).frames)
    .toBeGreaterThan(before + 2);
  expect(await counters()).toMatchObject({ opened: 1, closed: 0 });
  await page.getByRole('button', { name: 'More call options' }).click();
  await page.getByRole('menuitem', { name: 'Hide camera overlay', exact: true }).click();
  await expect.poll(async () => (await counters()).closed).toBe(1);
  await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
  await page.getByRole('button', { name: 'More call options' }).click();
  await page.getByRole('menuitem', { name: 'Show camera overlay', exact: true }).click();
  await expect.poll(async () => (await counters()).opened).toBe(2);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.call-footer').hover();
  await expect(
    page.getByRole('button', { name: 'Hide camera overlay' }),
  ).toBeVisible();
  expect(await counters()).toMatchObject({ opened: 2, closed: 1 });
  await page.getByRole('button', { name: 'Leave call' }).click();
  await expect.poll(async () => (await counters()).closed).toBe(2);
});
