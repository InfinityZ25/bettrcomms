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
      headers: { Origin: origin }, data: { name: 'Multi Device Ada', email },
    });
    if (response.status() !== 429 || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  } while (true);
  const body = await json<User | { user: User }>(response);
  return 'user' in body ? body.user : body;
}

test('same account can add a device or move the call to a new device', async ({ browser }) => {
  test.setTimeout(160_000);
  const firstContext = await browser.newContext({ baseURL });
  const secondContext = await browser.newContext({ baseURL });
  const replacementContext = await browser.newContext({ baseURL });
  try {
    const email = `multi-device-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const [firstUser, secondUser, replacementUser] = await Promise.all([
      login(firstContext, email), login(secondContext, email), login(replacementContext, email),
    ]);
    expect(secondUser.id).toBe(firstUser.id);
    expect(replacementUser.id).toBe(firstUser.id);
    const room = (await json<{ room: Room }>(await firstContext.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: 'Multi device room' },
    }))).room;
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();
    const replacementPage = await replacementContext.newPage();
    await Promise.all([firstPage.goto('/'), secondPage.goto('/'), replacementPage.goto('/')]);
    await Promise.all([
      firstPage.getByRole('button', { name: room.name }).click(),
      secondPage.getByRole('button', { name: room.name }).click(),
      replacementPage.getByRole('button', { name: room.name }).click(),
    ]);

    await firstPage.getByRole('button', { name: 'Join call' }).click();
    await expect(firstPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(secondPage.getByText('You’re already in this call on another device.')).toBeVisible();
    await secondPage.getByRole('button', { name: 'Connect second device' }).click();
    await expect(secondPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(firstPage.locator('.camera-tile:not(.self)')).toHaveCount(1);
    await expect(secondPage.locator('.camera-tile:not(.self)')).toHaveCount(1);
    await expect(firstPage.getByText('Voice connected')).toBeVisible();
    await expect(secondPage.getByText('Voice connected')).toBeVisible();

    const deviceCount = async () => {
      const data = await json<{ rooms: { room_id: string; participants: { user_id: string; device_count: number }[] }[] }>(
        await replacementContext.request.get('/api/v1/call-presence'),
      );
      return data.rooms.find(entry => entry.room_id === room.id)?.participants.find(entry => entry.user_id === firstUser.id)?.device_count;
    };
    await expect.poll(deviceCount).toBe(2);
    await expect(replacementPage.getByText('You’re already in this call on 2 devices.')).toBeVisible();

    await replacementPage.getByRole('button', { name: 'Reconnect from here' }).click();
    await expect(replacementPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(firstPage.getByRole('button', { name: 'Leave call' })).toHaveCount(0);
    await expect(secondPage.getByRole('button', { name: 'Leave call' })).toHaveCount(0);
    await expect.poll(deviceCount).toBe(1);
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close(), replacementContext.close()]);
  }
});
