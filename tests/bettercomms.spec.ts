import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

type User = { id: string; name: string; email: string };
type Room = { id: string; name: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

const syntheticDisplayCapture = () => {
  const original = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const graphics = canvas.getContext('2d')!;
      let frame = 0;
      const paint = () => {
        graphics.fillStyle = frame++ % 2 ? '#6146e5' : '#19a974';
        graphics.fillRect(0, 0, canvas.width, canvas.height);
        graphics.fillStyle = '#fff';
        graphics.font = '48px sans-serif';
        graphics.fillText('Synthetic screen', 90, 190);
      };
      paint();
      const timer = window.setInterval(paint, 100);
      const stream = canvas.captureStream(10);
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]!);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        clearInterval(timer);
        oscillator.stop();
        void context.close();
      }, { once: true });
      return stream;
    },
  });
  (window as unknown as { __originalDisplayCapture?: unknown }).__originalDisplayCapture = original;
};

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()} ${response.url()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function devLogin(context: BrowserContext, name: string, email: string): Promise<User> {
  const response = await context.request.post('/api/v1/auth/dev', {
    headers: { Origin: origin },
    data: { name, email },
  });
  const body = await json<User | { user: User }>(response);
  return 'user' in body ? body.user : body;
}

async function prepareRoom(ownerContext: BrowserContext, guestContext: BrowserContext) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = await devLogin(ownerContext, 'Ada E2E', `ada-${suffix}@example.test`);
  const guest = await devLogin(guestContext, 'Grace E2E', `grace-${suffix}@example.test`);
  const requestResponse = await ownerContext.request.post('/api/v1/friends/requests', {
    headers: { Origin: origin }, data: { user_id: guest.id },
  });
  const friendRequest = await json<{ request: { id: string } }>(requestResponse);
  await json(await guestContext.request.post(`/api/v1/friends/requests/${friendRequest.request.id}/accept`, {
    headers: { Origin: origin }, data: {},
  }));
  const roomResponse = await ownerContext.request.post('/api/v1/rooms', {
    headers: { Origin: origin }, data: { name: `Media room ${suffix}` },
  });
  const { room } = await json<{ room: Room }>(roomResponse);
  await json(await ownerContext.request.post(`/api/v1/rooms/${room.id}/members`, {
    headers: { Origin: origin }, data: { user_id: guest.id },
  }));
  return { owner, guest, room };
}

async function expectDecodedVideo(page: Page, selector: string): Promise<void> {
  await expect.poll(async () => page.locator(selector).evaluateAll((videos: HTMLVideoElement[]) =>
    videos.some((video) => video.videoWidth > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA),
  )).toBe(true);
}

test('two members chat, call, record separate tracks, and transport a screen share', async ({ browser }) => {
  const ownerContext = await browser.newContext({ acceptDownloads: true, baseURL });
  const guestContext = await browser.newContext({ acceptDownloads: true, baseURL });

  try {
    const publicPage = await ownerContext.newPage();
    await publicPage.goto('/');
    await expect(publicPage.getByRole('button', { name: /sign in to join/i })).toBeVisible();
    await publicPage.screenshot({ path: 'tests/screenshots/public-login.png', fullPage: true });

    const { room } = await prepareRoom(ownerContext, guestContext);
    const ownerPage = publicPage;
    const guestPage = await guestContext.newPage();
    await Promise.all([ownerPage.reload(), guestPage.goto('/')]);
    await Promise.all([
      expect(ownerPage.getByRole('button', { name: room.name })).toBeVisible(),
      expect(guestPage.getByRole('button', { name: room.name })).toBeVisible(),
    ]);
    await ownerPage.screenshot({ path: 'tests/screenshots/signed-room.png', fullPage: true });

    const message = `persistent message ${Date.now()}`;
    await ownerPage.getByRole('textbox', { name: /message your room/i }).fill(message);
    await ownerPage.getByRole('button', { name: /send message/i }).click();
    await expect(guestPage.getByText(message)).toBeVisible({ timeout: 8_000 });
    await guestPage.reload();
    await expect(guestPage.getByText(message)).toBeVisible();

    await Promise.all([
      ownerPage.getByRole('button', { name: /join call/i }).click(),
      guestPage.getByRole('button', { name: /join call/i }).click(),
    ]);
    await Promise.all([
      expect(ownerPage.getByText(/1 connected/i)).toBeVisible(),
      expect(guestPage.getByText(/1 connected/i)).toBeVisible(),
    ]);
    const network = ownerPage.getByRole('button', { name: 'Connection diagnostics' });
    await expect(network).toContainText(/Call · \d+ ms/);
    await network.click();
    const connection = ownerPage.getByRole('region', { name: 'Connection details' });
    await expect(connection.locator('dl > div').filter({ hasText: 'Signaling server' })).toContainText(/\d+ ms/);
    await expect(connection).toContainText('Grace E2E');
    await ownerPage.screenshot({ path: 'tests/screenshots/call-connection.png', fullPage: true });
    await ownerPage.keyboard.press('Escape');
    await expect(connection).toBeHidden();

    await ownerPage.getByRole('button', { name: /audio and video settings/i }).click();
    await expect(ownerPage.getByRole('main', { name: 'Settings' })).toBeVisible();
    await ownerPage.getByRole('button', { name: /back to call/i }).click();
    await expect(ownerPage.getByRole('main', { name: 'Settings' })).toBeHidden();
    await expect(ownerPage.getByText(/1 connected/i)).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Recordings' }).click();
    await expect(ownerPage.getByRole('main', { name: 'Recordings' })).toBeVisible();
    await ownerPage.getByRole('button', { name: /back to call/i }).click();
    await expect(ownerPage.getByRole('main', { name: 'Recordings' })).toBeHidden();
    await expect(ownerPage.getByText(/1 connected/i)).toBeVisible();

    // Start with audio only, then require tracks added later to join the same session.
    await ownerPage.getByRole('button', { name: /record separate tracks/i }).click();
    await expect(ownerPage.getByText(/recording/i).first()).toBeVisible();
    await Promise.all([
      ownerPage.getByRole('button', { name: /turn on camera/i }).click(),
      guestPage.getByRole('button', { name: /turn on camera/i }).click(),
    ]);
    await Promise.all([
      expectDecodedVideo(ownerPage, '.camera-tile:not(.self) video'),
      expectDecodedVideo(guestPage, '.camera-tile:not(.self) video'),
    ]);

    await ownerPage.evaluate(syntheticDisplayCapture);
    await ownerPage.getByRole('button', { name: /share screen/i }).click();
    await expectDecodedVideo(guestPage, '.video-viewport video');
    await expect(guestPage.getByText(/screen/i).first()).toBeVisible();
    await guestPage.locator('[aria-label="Adjust participant volume"]').click();
    await expect(guestPage.getByText(/4 media tracks/i)).toBeVisible();
    await ownerPage.waitForTimeout(1_500);
    await ownerPage.getByRole('button', { name: /stop recording/i }).click();
    await expect(ownerPage.getByText('Saved to your recordings on this device.')).toBeVisible();
    await ownerPage.locator('.recording-downloads summary').click();
    const downloads = ownerPage.locator('.recording-downloads a');
    await expect.poll(() => downloads.count()).toBeGreaterThanOrEqual(3);
    await expect(ownerPage.locator('.recording-downloads a[download="manifest.json"]')).toBeVisible();
    const mediaNames = await downloads.evaluateAll((links) => links.map((link) => link.getAttribute('download') ?? '').filter((name) => name !== 'manifest.json'));
    expect(mediaNames.length).toBeGreaterThanOrEqual(2);
    expect(mediaNames.every((name) => /\.(webm|ogg|mp4)$/.test(name))).toBeTruthy();

    const manifestLink = ownerPage.locator('.recording-downloads a[download="manifest.json"]');
    await expect(manifestLink).toHaveAttribute('href', /^blob:/);
    const manifest = await manifestLink.evaluate(async (link: HTMLAnchorElement) => {
      const response = await fetch(link.href);
      return response.json() as Promise<{ tracks: Array<{ source: string; status: string; bytes: number }> }>;
    });
    expect(manifest.tracks.length).toBeGreaterThanOrEqual(2);
    expect(manifest.tracks.some((track) => track.source === 'microphone' && track.status === 'complete' && track.bytes > 0)).toBeTruthy();
    expect(manifest.tracks.some((track) => track.source === 'camera' && track.status === 'complete' && track.bytes > 0)).toBeTruthy();
    expect(manifest.tracks.some((track) => track.source === 'screen' && track.status === 'complete' && track.bytes > 0)).toBeTruthy();
    expect(manifest.tracks.some((track) => track.source === 'system' && track.status === 'complete' && track.bytes > 0)).toBeTruthy();

    await ownerPage.getByRole('button', { name: /stop sharing/i }).click();
    await expect(guestPage.locator('.video-viewport video')).toHaveCount(0);
    await expect(guestPage.getByText(/2 media tracks/i)).toBeVisible();
    await ownerPage.getByRole('button', { name: /turn off camera/i }).click();
    await expect(guestPage.locator('.camera-tile:not(.self) video')).toHaveCount(0);
    await ownerPage.getByRole('button', { name: /leave call/i }).click();
    await expect(guestPage.locator('.camera-tile:not(.self):not(.invite)')).toHaveCount(0);
  } finally {
    await Promise.all([ownerContext.close(), guestContext.close()]);
  }
});
