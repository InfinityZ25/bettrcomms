import { expect, test, type APIResponse } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()} ${response.url()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('mobile call switches to a browser-exposed camera without recapturing the microphone', async ({ browser, browserName }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 430, height: 932 },
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone', 'camera'],
  });
  const installMediaProbe = () => {
    if (!navigator.mediaDevices) return;
    const media = navigator.mediaDevices;
    const originalEnumerate = media.enumerateDevices.bind(media);
    const probe = {
      captures: [] as string[],
      tracks: [] as MediaStreamTrack[],
      microphoneCaptures: 0,
      audioContexts: [] as AudioContext[],
      busyInjected: false,
    };
    Object.assign(window, { __cameraSourceProbe: probe });
    Object.defineProperty(media, 'enumerateDevices', {
      configurable: true,
      value: async () => [
        ...await originalEnumerate(),
        { kind: 'videoinput', deviceId: 'phone-front', groupId: 'phone', label: 'Front camera' },
        { kind: 'videoinput', deviceId: 'phone-back', groupId: 'phone', label: 'Back camera' },
        { kind: 'videoinput', deviceId: 'browser-accessory', groupId: 'accessory', label: 'Connected camera' },
      ],
    });
    Object.defineProperty(media, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        if (!constraints.video) {
          probe.microphoneCaptures += 1;
          const audio = new AudioContext();
          const source = audio.createOscillator();
          const destination = audio.createMediaStreamDestination();
          source.connect(destination);
          source.start();
          probe.audioContexts.push(audio);
          return destination.stream;
        }
        const video = constraints.video;
        const device = typeof video === 'object' && video.deviceId &&
          typeof video.deviceId === 'object' && 'exact' in video.deviceId
          ? String(video.deviceId.exact) : 'phone-front';
        probe.captures.push(device);
        if (device === 'browser-accessory' && !probe.busyInjected &&
            probe.tracks[0]?.readyState === 'live') {
          probe.busyInjected = true;
          throw new DOMException('The current camera is still active', 'NotReadableError');
        }
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        canvas.getContext('2d')!.fillRect(0, 0, 640, 360);
        const track = canvas.captureStream(12).getVideoTracks()[0];
        Object.defineProperty(track, 'getSettings', {
          configurable: true,
          value: () => ({ deviceId: device, width: 640, height: 360 }),
        });
        probe.tracks.push(track);
        return new MediaStream([track]);
      },
    });
  };

  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await json(await context.request.post('/api/v1/auth/dev', {
      headers: { Origin: origin },
      data: { name: 'Mobile camera', email: `camera-${suffix}@example.test` },
    }));
    const { room } = await json<{ room: { id: string; name: string } }>(
      await context.request.post('/api/v1/rooms', {
        headers: { Origin: origin }, data: { name: 'Mobile cameras' },
      }),
    );
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: room.name })).toBeVisible();
    if (browserName === 'chromium') await page.evaluate(installMediaProbe);
    await page.getByRole('button', { name: 'Join call' }).click();
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();

    if (browserName === 'webkit') {
      // WebKit does not reveal device IDs until camera access has been granted.
      await page.getByRole('button', { name: 'Turn on camera' }).click();
      await expect(page.getByRole('button', { name: 'Turn off camera' })).toBeVisible();
      await page.getByRole('button', { name: 'Turn off camera' }).click();
      await expect(page.getByRole('button', { name: 'Turn on camera' })).toBeVisible();
      await page.getByRole('button', { name: 'Choose camera' }).click();
      const cameras = await page.evaluate(async () =>
        (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput' && device.deviceId)
          .map((device) => ({ id: device.deviceId, label: device.label })),
      );
      expect(cameras.length).toBeGreaterThan(1);
      await page.getByRole('menuitemradio', { name: cameras[1].label }).click();
      await expect.poll(() => page.evaluate(() => localStorage.getItem('bc-camera'))).toBe(cameras[1].id);
      await expect(page.getByRole('button', { name: 'Turn on camera' })).toBeVisible();
      await page.getByRole('button', { name: 'Turn on camera' }).click();
      await expect(page.getByRole('button', { name: 'Turn off camera' })).toBeVisible();
      await page.getByRole('button', { name: 'Leave call' }).click();
      return;
    }
    await page.getByRole('button', { name: 'Choose camera' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Back camera' })).toBeVisible();
    await page.getByRole('menuitemradio', { name: 'Back camera' }).click();
    await expect(page.getByRole('button', { name: 'Turn on camera' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('bc-camera'))).toBe('phone-back');
    expect(await page.evaluate(() => {
      const probe = (window as typeof window & { __cameraSourceProbe: {
        captures: string[]; microphoneCaptures: number;
      } }).__cameraSourceProbe;
      return { captures: probe.captures, microphoneCaptures: probe.microphoneCaptures };
    })).toEqual({ captures: [], microphoneCaptures: 1 });
    await page.getByRole('button', { name: 'Turn on camera' }).click();
    await expect(page.getByRole('button', { name: 'Turn off camera' })).toBeVisible();
    await page.getByRole('button', { name: 'Choose camera' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Connected camera' })).toBeVisible();
    await page.getByRole('menuitemradio', { name: 'Connected camera' }).click();
    await expect(page.getByRole('button', { name: 'Turn off camera' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & { __cameraSourceProbe: {
        captures: string[]; tracks: MediaStreamTrack[]; microphoneCaptures: number;
      } }).__cameraSourceProbe;
      return {
        captures: probe.captures,
        oldCameraLive: probe.tracks[0]?.readyState === 'live',
        microphoneCaptures: probe.microphoneCaptures,
        selected: localStorage.getItem('bc-camera'),
      };
    })).toEqual({
      captures: ['phone-back', 'browser-accessory'],
      oldCameraLive: true,
      microphoneCaptures: 1,
      selected: 'phone-back',
    });
    await expect(page.getByRole('alert')).toContainText('Turn off your camera, choose the new source, then turn it on.');
    await page.getByRole('button', { name: 'Dismiss notification' }).click();
    await page.getByRole('button', { name: 'Turn off camera' }).click();
    await expect(page.getByRole('button', { name: 'Turn on camera' })).toBeVisible();
    await page.getByRole('button', { name: 'Choose camera' }).click();
    await page.getByRole('menuitemradio', { name: 'Connected camera' }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('bc-camera'))).toBe('browser-accessory');
    await page.getByRole('button', { name: 'Turn on camera' }).click();
    await expect(page.getByRole('button', { name: 'Turn off camera' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & { __cameraSourceProbe: {
        captures: string[]; tracks: MediaStreamTrack[]; microphoneCaptures: number;
      } }).__cameraSourceProbe;
      return {
        captures: probe.captures,
        oldCameraStopped: probe.tracks[0]?.readyState === 'ended',
        microphoneCaptures: probe.microphoneCaptures,
      };
    })).toEqual({
      captures: ['phone-back', 'browser-accessory', 'browser-accessory'],
      oldCameraStopped: true,
      microphoneCaptures: 1,
    });
    await page.getByRole('button', { name: 'Leave call' }).click();
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & { __cameraSourceProbe: {
        tracks: MediaStreamTrack[];
      } }).__cameraSourceProbe;
      return probe.tracks.every((track) => track.readyState === 'ended');
    })).toBe(true);
    await page.evaluate(async () => {
      const probe = (window as typeof window & { __cameraSourceProbe: {
        audioContexts: AudioContext[];
      } }).__cameraSourceProbe;
      await Promise.all(probe.audioContexts.map((audio) => audio.close()));
    });
  } finally {
    await context.close();
  }
});
