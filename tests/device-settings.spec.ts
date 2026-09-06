import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
// Local device preferences are available without an account.

async function openSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /audio and video settings/i }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: /media devices/i }),
  ).toBeVisible();
}

test('settings are passive until asked, then record a five-second fake microphone sample and preview the fake camera', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    const calls: MediaStreamConstraints[] = [];
    Object.defineProperty(window, '__deviceCaptureCalls', { value: calls });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        calls.push(constraints);
        return original(constraints);
      },
    });
  });

  await openSettings(page);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __deviceCaptureCalls: unknown[] })
          .__deviceCaptureCalls.length,
    ),
  ).toBe(0);
  await page.goBack();
  await expect(page.getByRole('main', { name: 'Settings' })).toBeHidden();
  await expect(
    page.getByRole('button', { name: /audio and video settings/i }),
  ).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __deviceCaptureCalls: unknown[] })
          .__deviceCaptureCalls.length,
    ),
  ).toBe(0);

  await page.getByRole('button', { name: 'Test microphone' }).click();
  await expect(
    page.getByText(
      /recording a 5-second (?:browser|rnnoise|suppression off) sample/i,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/playing your 5-second .*microphone sample/i),
  ).toBeVisible({ timeout: 8_000 });

  await page.getByRole('button', { name: 'Preview camera' }).click();
  await expect(
    page.getByText(/camera preview is local and is not being recorded/i),
  ).toBeVisible();
  const preview = page.locator('.device-settings__preview');
  await expect
    .poll(() =>
      preview.evaluate(
        (video: HTMLVideoElement) =>
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          video.videoWidth > 0,
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Stop preview' }).click();
  await expect(page.getByText('Preview stopped.')).toBeVisible();
  await context.close();
});

test('permission denial is actionable and a capture that resolves after leaving settings is stopped', async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.addInitScript(() => {
    let mode: 'deny' | 'pending' = 'deny';
    let resolvePending: ((stream: MediaStream) => void) | undefined;
    let lateTrack: MediaStreamTrack | undefined;
    Object.assign(window, {
      __usePendingCapture: () => {
        mode = 'pending';
      },
      __resolvePendingCapture: () => {
        const audio = new AudioContext();
        const track = audio
          .createMediaStreamDestination()
          .stream.getAudioTracks()[0]!;
        lateTrack = track;
        resolvePending?.(new MediaStream([track]));
      },
      __lateTrackState: () => lateTrack?.readyState,
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () => {
        if (mode === 'deny')
          return Promise.reject(
            new DOMException('Permission denied', 'NotAllowedError'),
          );
        return new Promise<MediaStream>((resolve) => {
          resolvePending = resolve;
        });
      },
    });
  });

  await openSettings(page);
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(
    page.getByText(
      /microphone access was denied.*browser or system privacy settings/i,
    ),
  ).toBeVisible();

  await page.evaluate(() =>
    (
      window as unknown as { __usePendingCapture(): void }
    ).__usePendingCapture(),
  );
  await page.getByRole('button', { name: 'Preview camera' }).click();
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    (
      window as unknown as { __resolvePendingCapture(): void }
    ).__resolvePendingCapture(),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __lateTrackState(): string }
        ).__lateTrackState(),
      ),
    )
    .toBe('ended');
  await context.close();
});

test('output selection applies live and the routing helper follows stored output changes for media and audio contexts', async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const devices = [
      {
        deviceId: 'mic-realistic',
        groupId: 'group-in',
        kind: 'audioinput',
        label: 'Studio microphone',
        toJSON() {
          return this;
        },
      },
      {
        deviceId: 'camera-realistic',
        groupId: 'group-cam',
        kind: 'videoinput',
        label: 'Desk camera',
        toJSON() {
          return this;
        },
      },
      {
        deviceId: 'speaker-realistic',
        groupId: 'group-out',
        kind: 'audiooutput',
        label: 'Desk speakers',
        toJSON() {
          return this;
        },
      },
    ] as MediaDeviceInfo[];
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: async () => devices,
    });
  });
  await openSettings(page);
  await page.getByLabel('Output device').selectOption('speaker-realistic');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('bc-output')))
    .toBe('speaker-realistic');

  const result = await page.evaluate(async () => {
    const calls: string[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      value(id: string) {
        calls.push(`media:${id}`);
        return Promise.resolve();
      },
    });
    Object.defineProperty(AudioContext.prototype, 'setSinkId', {
      configurable: true,
      value(id: string) {
        calls.push(`context:${id}`);
        return Promise.resolve();
      },
    });
    const { applyOutputDevice, followOutputDevice } =
      await import('/src/media/output.ts');
    const media = document.createElement('audio');
    const audio = new AudioContext();
    await applyOutputDevice(media);
    const errors: string[] = [];
    const stopMedia = followOutputDevice(media, (error) =>
      errors.push(error.message),
    );
    const stopContext = followOutputDevice(audio, (error) =>
      errors.push(error.message),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    localStorage.setItem('bc-output', 'headset-current');
    window.dispatchEvent(new Event('bc-output'));
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stopMedia();
    stopContext();
    await audio.close();
    return { calls, errors };
  });
  expect(result.errors).toEqual([]);
  expect(result.calls).toContain('media:speaker-realistic');
  expect(result.calls).toContain('media:headset-current');
  expect(result.calls).toContain('context:headset-current');
  await context.close();
});

test('devicechange refreshes the lists and the settings screen remains usable on mobile', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    let changed = false;
    Object.assign(window, {
      __changeDevices: () => {
        changed = true;
        navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: async () =>
        [
          {
            deviceId: changed ? 'usb-mic' : 'default-mic',
            groupId: 'input',
            kind: 'audioinput',
            label: changed ? 'USB microphone' : 'Default microphone',
            toJSON() {
              return this;
            },
          },
          {
            deviceId: 'camera',
            groupId: 'video',
            kind: 'videoinput',
            label: 'Camera',
            toJSON() {
              return this;
            },
          },
          {
            deviceId: 'speaker',
            groupId: 'output',
            kind: 'audiooutput',
            label: 'Speakers',
            toJSON() {
              return this;
            },
          },
        ] as MediaDeviceInfo[],
    });
  });
  await openSettings(page);
  await expect(
    page
      .getByLabel('Microphone')
      .getByRole('option', { name: 'Default microphone' }),
  ).toHaveCount(1);
  await page.evaluate(() =>
    (window as unknown as { __changeDevices(): void }).__changeDevices(),
  );
  await expect(
    page
      .getByLabel('Microphone')
      .getByRole('option', { name: 'USB microphone' }),
  ).toHaveCount(1);
  await page.screenshot({
    path: '.local/device-settings-mobile.png',
    fullPage: true,
  });
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  await context.close();
});
