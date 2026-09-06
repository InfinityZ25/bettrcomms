import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

async function openSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /audio and video settings/i }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
}

test('camera quality stays passive, reports actual capture, and reacquires with supported settings', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1200, height: 850 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    const calls: MediaStreamConstraints[] = [];
    const stopped: boolean[] = [];
    Object.defineProperty(window, '__cameraQualityProbe', {
      value: { calls, stopped },
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        calls.push(structuredClone(constraints));
        const stream = await original(constraints);
        const track = stream.getVideoTracks()[0];
        if (!track) return stream;
        const index = stopped.push(false) - 1;
        const originalStop = track.stop.bind(track);
        Object.defineProperties(track, {
          getCapabilities: {
            configurable: true,
            value: () => ({
              width: { min: 640, max: 1920 },
              height: { min: 480, max: 1080 },
              frameRate: { min: 15, max: 30 },
            }),
          },
          getSettings: {
            configurable: true,
            value: () =>
              index === 0
                ? { width: 1600, height: 900, frameRate: 29.97 }
                : { width: 1280, height: 720, frameRate: 30 },
          },
          stop: {
            configurable: true,
            value: () => {
              stopped[index] = true;
              originalStop();
            },
          },
        });
        return stream;
      },
    });
  });

  await openSettings(page);
  const resolution = page.getByLabel('Resolution');
  const frameRate = page.locator('.camera-quality').getByLabel('Frame rate');
  await expect(resolution).toHaveValue('1080p');
  await expect(frameRate).toHaveValue('30');
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __cameraQualityProbe: { calls: MediaStreamConstraints[] };
          }
        ).__cameraQualityProbe.calls.length,
    ),
  ).toBe(0);

  await page.getByRole('button', { name: 'Preview camera' }).click();
  await expect(
    page.getByText(/requested 1080p at 30 FPS\. actual 1600×900 at 30 FPS/i),
  ).toBeVisible();
  await expect(
    page.getByText(/camera reports 1600×900 at 30 FPS/i),
  ).toBeVisible();
  const first = await page.evaluate(
    () =>
      (
        window as unknown as {
          __cameraQualityProbe: { calls: MediaStreamConstraints[] };
        }
      ).__cameraQualityProbe.calls[0],
  );
  expect(first).toEqual({
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
  await expect(resolution.locator('option[value="1440p"]')).toHaveAttribute(
    'disabled',
    '',
  );
  await expect(resolution.locator('option[value="4k"]')).toHaveAttribute(
    'disabled',
    '',
  );
  await expect(frameRate.locator('option[value="60"]')).toHaveAttribute(
    'disabled',
    '',
  );

  await resolution.selectOption('720p');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __cameraQualityProbe: {
                calls: MediaStreamConstraints[];
                stopped: boolean[];
              };
            }
          ).__cameraQualityProbe,
      ),
    )
    .toMatchObject({ stopped: [true, false] });
  await expect(
    page.getByText(/requested 720p at 30 FPS\. actual 1280×720 at 30 FPS/i),
  ).toBeVisible();
  const second = await page.evaluate(
    () =>
      (
        window as unknown as {
          __cameraQualityProbe: { calls: MediaStreamConstraints[] };
        }
      ).__cameraQualityProbe.calls[1],
  );
  expect(second).toEqual({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('bc-camera-resolution')),
    )
    .toBe('720p');

  await page.getByRole('button', { name: 'Stop preview' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __cameraQualityProbe: { stopped: boolean[] };
            }
          ).__cameraQualityProbe.stopped,
      ),
    )
    .toEqual([true, true]);
  await context.close();
});
