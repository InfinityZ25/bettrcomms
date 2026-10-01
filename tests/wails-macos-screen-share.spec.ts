import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

test('macOS Wails routes Share to webview capture without opening native setup', async ({ browser }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + 65_000;
    let login;
    for (;;) {
      login = await context.request.post('/api/v1/auth/dev', {
        headers: { Origin: origin },
        data: { name: 'Mac Share', email: `mac-share-${suffix}@example.test` },
      });
      if (login.status() !== 429 || Date.now() >= deadline) break;
      await login.dispose();
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    expect(login.ok()).toBeTruthy();
    const created = await context.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: `Mac share ${suffix}` },
    });
    expect(created.ok()).toBeTruthy();

    await context.addInitScript(() => {
      const unavailable = { state: 'unavailable', detail: 'No macOS native capture adapter.', fallback: 'browser getDisplayMedia' };
      Object.assign(window, {
        __BETTERCOMMS_DESKTOP__: {
          schemaVersion: 1, runtime: 'wails', hostVersion: 'test',
          platform: 'darwin', architecture: 'arm64', apiOrigin: '',
          authReturn: unavailable,
          windowControls: {
            platform: 'macos', mode: 'native-frame', height: 0,
            insetStart: 0, insetEnd: 0, buttons: [], buttonSide: 'start',
          },
          capabilities: {
            schemaVersion: 1, platform: 'darwin', architecture: 'arm64',
            browserMedia: { state: 'implemented', detail: 'webview media' },
            nativeGameVideo: unavailable, nativeProcessAudio: unavailable,
            nativeMicrophoneDsp: unavailable, localTrackRecording: unavailable,
            mediaPermissions: unavailable, globalInput: unavailable,
            nativeOverlays: unavailable, notes: [],
          },
        },
      });
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 360;
          canvas.getContext('2d')!.fillRect(0, 0, 640, 360);
          Object.assign(window, { __macSharePickerOpened: true });
          return canvas.captureStream(12);
        },
      });
    });

    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Join call' }).click();
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await page.getByRole('button', { name: 'Share screen' }).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __macSharePickerOpened?: boolean }).__macSharePickerOpened))).toBe(true);
    await expect(page.getByRole('main', { name: 'Share your screen' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
  } finally {
    await context.close();
  }
});
