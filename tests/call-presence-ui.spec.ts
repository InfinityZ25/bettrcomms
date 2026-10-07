import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';

type User = { id: string; name: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;
const json = async <T>(response: APIResponse) => {
  if (!response.ok()) throw new Error(await response.text());
  return response.json() as Promise<T>;
};
const login = async (context: BrowserContext, name: string, email: string) => {
  const deadline = Date.now() + 65_000;
  let response: APIResponse;
  do {
    response = await context.request.post('/api/v1/auth/dev', { headers: { Origin: origin }, data: { name, email } });
    if (response.status() !== 429 || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  } while (true);
  const value = await json<User | { user: User }>(response);
  return 'user' in value ? value.user : value;
};

test('channels open chat first and navigation shows live mute and deafen presence', async ({ browser }) => {
  test.setTimeout(160_000);
  const ownerContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const owner = await login(ownerContext, 'Lobby Ada', `lobby-ada-${suffix}@example.test`);
    const guest = await login(guestContext, 'Lobby Grace', `lobby-grace-${suffix}@example.test`);
    const request = await json<{ request: { id: string } }>(await ownerContext.request.post('/api/v1/friends/requests', {
      headers: { Origin: origin }, data: { user_id: guest.id },
    }));
    await json(await guestContext.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, {
      headers: { Origin: origin }, data: {},
    }));
    const created = await json<{ room: { id: string; name: string } }>(await ownerContext.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: 'Presence lounge' },
    }));
    await json(await ownerContext.request.post(`/api/v1/rooms/${created.room.id}/members`, {
      headers: { Origin: origin }, data: { user_id: guest.id },
    }));
    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();
    await Promise.all([ownerPage.goto('/'), guestPage.goto('/')]);
    await Promise.all([
      ownerPage.getByRole('button', { name: created.room.name, exact: true }).click(),
      guestPage.getByRole('button', { name: created.room.name, exact: true }).click(),
    ]);
    await expect(guestPage.getByRole('textbox', { name: `Message ${created.room.name}`, exact: true })).toBeVisible();
    await expect(guestPage.getByRole('region', { name: 'Call lobby' })).toHaveCount(0);
    await expect(guestPage.getByRole('button', { name: 'Leave call', exact: true })).toHaveCount(0);
    await expect(guestPage.getByRole('button', { name: 'Join voice', exact: true })).toBeEnabled();
    await guestPage.screenshot({ path: 'tests/screenshots/channel-chat-desktop.png', fullPage: true });
    await guestPage.setViewportSize({ width: 390, height: 844 });
    await guestPage.screenshot({ path: 'tests/screenshots/channel-chat-mobile.png', fullPage: true });
    await guestPage.setViewportSize({ width: 1280, height: 900 });

    await ownerPage.getByRole('button', { name: 'Join voice', exact: true }).click();
    await expect(ownerPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    const participants = guestPage.getByRole('list', { name: `${created.room.name} call participants`, exact: true });
    await expect(participants).toContainText('Lobby Ada');
    await ownerPage.screenshot({ path: 'tests/screenshots/call-presence-incall-desktop.png', fullPage: true });
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    if (await ownerPage.getByRole('button', { name: 'Back to call', exact: true }).isVisible()) await ownerPage.getByRole('button', { name: 'Back to call', exact: true }).click();
    await ownerPage.screenshot({ path: 'tests/screenshots/call-presence-incall-mobile.png', fullPage: true });
    await ownerPage.setViewportSize({ width: 1280, height: 900 });

    await ownerPage.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(participants).toContainText('Lobby Ada · muted');
    await ownerPage.getByRole('button', { name: 'Deafen call' }).click();
    await expect(participants).toContainText('Lobby Ada · deafened');
    await ownerPage.getByRole('button', { name: 'Undeafen call' }).click();
    await expect(ownerPage.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();

    await guestPage.getByRole('button', { name: 'Join voice', exact: true }).click();
    await expect(guestPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(guestPage.locator('.camera-tile:not(.self)').getByLabel('Muted')).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Deafen call' }).click();
    await expect(guestPage.locator('.camera-tile:not(.self)').getByLabel('Deafened')).toBeVisible();

    await guestPage.routeWebSocket(/\/api\/v1\/events/, (socket) => socket.close());
    await guestPage.reload();
    await expect(guestPage.getByText('Call activity unavailable')).toBeVisible();
    await expect(guestPage.getByRole('textbox', { name: `Message ${created.room.name}`, exact: true })).toBeVisible();
    await expect(guestPage.getByRole('list', { name: `${created.room.name} call participants`, exact: true })).toHaveCount(0);
    await expect(guestPage.getByRole('button', { name: 'Join voice', exact: true })).toBeEnabled();
  } finally {
    await Promise.allSettled([ownerContext.close(), guestContext.close()]);
  }
});
