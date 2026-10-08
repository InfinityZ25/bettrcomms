import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';

type User = { id: string; name: string };
type Room = { id: string; name: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()} ${response.url()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext, email: string) {
  const deadline = Date.now() + 65_000;
  let response: APIResponse;
  do {
    response = await context.request.post('/api/v1/auth/dev', {
      headers: { Origin: origin }, data: { name: 'Resume Ada', email },
    });
    if (response.status() !== 429 || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  } while (true);
  const body = await json<User | { user: User }>(response);
  return 'user' in body ? body.user : body;
}

/** Keeps the room signaling sockets reachable so a server drop can be staged. */
const recordRoomSockets = () => {
  const Native = window.WebSocket;
  (window as Window & { __roomSockets?: WebSocket[] }).__roomSockets = [];
  class Recorded extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (String(url).includes('/ws?'))
        (window as Window & { __roomSockets?: WebSocket[] }).__roomSockets!.push(this);
    }
    send(data: Parameters<WebSocket['send']>[0]) {
      if ((window as Window & { __stalledRoomSocket?: WebSocket }).__stalledRoomSocket === this) return;
      if (typeof data === 'string' && this.url.includes('/ws?')) {
        const message = JSON.parse(data);
        if (message.type === 'presence') {
          const state = window as Window & { __resumePresence?: Record<string, unknown>[] };
          state.__resumePresence ??= [];
          state.__resumePresence.push(message.payload);
        }
      }
      super.send(data);
    }
  }
  window.WebSocket = Recorded as unknown as typeof WebSocket;
  if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const graphics = canvas.getContext('2d')!; graphics.fillStyle = '#208445'; graphics.fillRect(0, 0, 640, 360);
      return canvas.captureStream(1);
    },
  });
};

for (const interruption of ['restart', 'stalled socket'] as const) {
  test(`a signaling ${interruption} does not end an established peer-to-peer call`, async ({ browser }) => {
    test.setTimeout(160_000);
    const firstContext = await browser.newContext({ baseURL });
    const secondContext = await browser.newContext({ baseURL });
    try {
      await Promise.all([
        firstContext.addInitScript(recordRoomSockets),
        secondContext.addInitScript(recordRoomSockets),
      ]);
      const email = `signaling-resume-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
      const [firstUser, secondUser] = await Promise.all([
        login(firstContext, email), login(secondContext, email),
      ]);
      expect(secondUser.id).toBe(firstUser.id);
      const room = (await json<{ room: Room }>(await firstContext.request.post('/api/v1/rooms', {
        headers: { Origin: origin }, data: { name: 'Resume room' },
      }))).room;
      const firstPage = await firstContext.newPage();
      const secondPage = await secondContext.newPage();
      await Promise.all([firstPage.goto('/'), secondPage.goto('/')]);
      await Promise.all([
        firstPage.getByRole('button', { name: room.name, exact: true }).click(),
        secondPage.getByRole('button', { name: room.name, exact: true }).click(),
      ]);

      await firstPage.getByRole('button', { name: 'Join voice' }).click();
      await expect(firstPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
      await secondPage.getByRole('button', { name: 'Add this device', exact: true }).click();
      await expect(secondPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
      await expect(firstPage.getByRole('button', { name: 'Connection diagnostics' })).toHaveAttribute('title', /Call ping: \d+ ms/);
      await expect(secondPage.getByRole('button', { name: 'Connection diagnostics' })).toHaveAttribute('title', /Call ping: \d+ ms/);
      await expect(firstPage.locator('.camera-tile:not(.self):not(.screen-share-tile)')).toHaveCount(1);
      await expect(firstPage.locator('.camera-tile:not(.self):not(.screen-share-tile) .online-dot')).toBeVisible();
      await firstPage.getByRole('button', { name: 'Turn on camera', exact: true }).click();
      await firstPage.getByRole('button', { name: 'Share screen', exact: true }).click();
      await firstPage.getByRole('button', { name: 'Record separate tracks', exact: true }).click();
      await expect(firstPage.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
      const remoteCamera = secondPage.locator('.camera-tile:not(.self):not(.screen-share-tile) video');
      await expect.poll(() => remoteCamera.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
      const cameraBeforeDrop = await remoteCamera.evaluate((video: HTMLVideoElement) => ({
        id: (video.srcObject as MediaStream).getVideoTracks()[0].id,
        frames: video.getVideoPlaybackQuality().totalVideoFrames,
      }));

      // Model either an abnormal disconnect or a network handoff that leaves the
      // socket open but drops traffic in both directions. The old registration
      // stays in place to exercise identity takeover without a peer departure.
      await firstPage.evaluate((interruption) => {
        (window as Window & { __resumePresence?: Record<string, unknown>[] }).__resumePresence = [];
        const sockets = (window as Window & { __roomSockets?: WebSocket[] }).__roomSockets ?? [];
        const socket = sockets[sockets.length - 1] as WebSocket & {
          onclose?: (event: { code: number; wasClean: boolean }) => void;
        };
        if (interruption === 'stalled socket') {
          (window as Window & { __stalledRoomSocket?: WebSocket }).__stalledRoomSocket = socket;
          socket.onmessage = () => {};
        } else socket.onclose?.({ code: 1006, wasClean: false });
      }, interruption);

      await expect(firstPage.getByText('Reconnecting to server')).toBeVisible({ timeout: 20_000 });
      // The call must survive: media is peer to peer and never needed the server.
      await expect(firstPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
      await expect(firstPage.locator('.camera-tile:not(.self):not(.screen-share-tile)')).toHaveCount(1);
      await expect(firstPage.getByText('Call disconnected. Join again to reconnect.')).toHaveCount(0);
      // The other device must not be told its peer left and rebuild the connection.
      await expect(secondPage.locator('.camera-tile:not(.self):not(.screen-share-tile)')).toHaveCount(1);

      await expect(firstPage.locator('.camera-tile:not(.self):not(.screen-share-tile) .online-dot')).toBeVisible();
      await expect.poll(() => firstPage.evaluate(() => {
        const updates = (window as Window & { __resumePresence?: Record<string, unknown>[] }).__resumePresence ?? [];
        return updates.length > 0 && updates.every(p => p.camera === true && p.sharing === true && p.recording === true);
      })).toBe(true);
      await expect(firstPage.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible();
      await expect(firstPage.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
      await expect(secondPage.getByRole('button', { name: 'Connection diagnostics' })).toHaveAttribute('title', /Call ping: \d+ ms/);

      await expect(firstPage.getByText('Reconnecting to server')).toHaveCount(0, { timeout: 30_000 });
      await expect(firstPage.locator('.camera-tile:not(.self):not(.screen-share-tile) .online-dot')).toBeVisible();
      await expect(firstPage.getByRole('button', { name: 'Connection diagnostics' })).toHaveAttribute('title', /Call ping: \d+ ms/);
      await expect(firstPage.locator('.camera-tile:not(.self):not(.screen-share-tile)')).toHaveCount(1);
      await expect(secondPage.locator('.camera-tile:not(.self):not(.screen-share-tile)')).toHaveCount(1);

      await expect.poll(() => remoteCamera.evaluate((video: HTMLVideoElement) => ({
        id: (video.srcObject as MediaStream).getVideoTracks()[0].id,
        state: (video.srcObject as MediaStream).getVideoTracks()[0].readyState,
      }))).toEqual({ id: cameraBeforeDrop.id, state: 'live' });
      await expect.poll(() => remoteCamera.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames))
        .toBeGreaterThan(cameraBeforeDrop.frames);

      // Signaling is usable again, so membership changes still work afterwards.
      await firstPage.getByRole('button', { name: 'Leave call' }).click();
      await expect(secondPage.locator('.camera-tile:not(.self):not(.screen-share-tile)')).toHaveCount(0);
    } finally {
      await Promise.allSettled([firstContext.close(), secondContext.close()]);
    }
  });
}
