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
  }
  window.WebSocket = Recorded as unknown as typeof WebSocket;
};

test('a signaling restart does not end an established peer-to-peer call', async ({ browser }) => {
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
      firstPage.getByRole('button', { name: room.name }).click(),
      secondPage.getByRole('button', { name: room.name }).click(),
    ]);

    await firstPage.getByRole('button', { name: 'Join call' }).click();
    await expect(firstPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await secondPage.getByRole('button', { name: 'Connect second device' }).click();
    await expect(secondPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(firstPage.getByText('Voice connected')).toBeVisible();
    await expect(secondPage.getByText('Voice connected')).toBeVisible();
    await expect(firstPage.locator('.camera-tile:not(.self)')).toHaveCount(1);

    // What a redeploy does: the socket dies abnormally and the server never
    // gets to announce a departure, while the peer connection carrying the
    // media stays healthy and untouched. The old registration is deliberately
    // left in place so the reconnection also exercises the server's resume
    // path, which must not tell anyone else that this peer left and returned.
    await firstPage.evaluate(() => {
      const sockets = (window as Window & { __roomSockets?: WebSocket[] }).__roomSockets ?? [];
      const socket = sockets[sockets.length - 1] as WebSocket & {
        onclose?: (event: { code: number; wasClean: boolean }) => void;
      };
      socket.onclose?.({ code: 1006, wasClean: false });
    });

    await expect(firstPage.getByText('Reconnecting to server')).toBeVisible();
    // The call must survive: media is peer to peer and never needed the server.
    await expect(firstPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(firstPage.locator('.camera-tile:not(.self)')).toHaveCount(1);
    await expect(firstPage.getByText('Call disconnected. Join again to reconnect.')).toHaveCount(0);
    // The other device must not be told its peer left and rebuild the connection.
    await expect(secondPage.locator('.camera-tile:not(.self)')).toHaveCount(1);
    await expect(secondPage.getByText('Voice connected')).toBeVisible();

    await expect(firstPage.getByText('Reconnecting to server')).toHaveCount(0, { timeout: 30_000 });
    await expect(firstPage.getByText('Voice connected')).toBeVisible();
    await expect(firstPage.locator('.camera-tile:not(.self)')).toHaveCount(1);
    await expect(secondPage.locator('.camera-tile:not(.self)')).toHaveCount(1);

    // Signaling is usable again, so membership changes still work afterwards.
    await firstPage.getByRole('button', { name: 'Leave call' }).click();
    await expect(secondPage.locator('.camera-tile:not(.self)')).toHaveCount(0);
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close()]);
  }
});
