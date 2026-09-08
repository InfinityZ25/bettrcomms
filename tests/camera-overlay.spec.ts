import { test, expect } from '@playwright/test';

test('overlay composites cameras without capturing devices or stopping source tracks', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { CameraOverlayCanvas } = await import('/src/media/cameraOverlayCanvas.ts');
    const source = document.createElement('canvas'); source.width = 160; source.height = 90;
    const graphics = source.getContext('2d')!; graphics.fillStyle = '#ff0000'; graphics.fillRect(0, 0, 160, 90);
    const stream = source.captureStream(10);
    const track = stream.getVideoTracks()[0];
    const overlay = new CameraOverlayCanvas();
    const cameras = [{ id: 'friend', name: 'Friend', track }];
    overlay.render(cameras, 240, 135);
    await new Promise(resolve => setTimeout(resolve, 300));
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
