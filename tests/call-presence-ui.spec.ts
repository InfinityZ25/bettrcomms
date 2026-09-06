import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';

type User = { id: string; name: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;
const json = async <T>(response: APIResponse) => {
  if (!response.ok()) throw new Error(await response.text());
  return response.json() as Promise<T>;
};
const login = async (context: BrowserContext, name: string, email: string) => {
  const value = await json<User | { user: User }>(await context.request.post('/api/v1/auth/dev', {
    headers: { Origin: origin }, data: { name, email },
  }));
  return 'user' in value ? value.user : value;
};

test('lobby and navigation show live mute and deafen presence', async ({ browser }) => {
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
      ownerPage.getByRole('button', { name: created.room.name }).click(),
      guestPage.getByRole('button', { name: created.room.name }).click(),
    ]);
    await expect(guestPage.getByRole('region', { name: 'Call lobby' })).toBeVisible();
    await expect(guestPage.getByRole('heading', { name: created.room.name })).toBeVisible();
    await expect(guestPage.getByText('No one has joined yet. You can be the first.')).toBeVisible();
    await guestPage.screenshot({ path: 'tests/screenshots/call-lobby-desktop.png', fullPage: true });
    await guestPage.setViewportSize({ width: 390, height: 844 });
    await guestPage.getByRole('button', { name: 'Close chat' }).click();
    await guestPage.screenshot({ path: 'tests/screenshots/call-lobby-mobile.png', fullPage: true });
    await guestPage.setViewportSize({ width: 1280, height: 900 });

    await ownerPage.getByRole('button', { name: 'Join call' }).click();
    await expect(ownerPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(guestPage.locator('.call-lobby')).toContainText('Lobby Ada');
    await expect(guestPage.locator('.conversation-navigation')).toContainText('Lobby Ada');
    await ownerPage.screenshot({ path: 'tests/screenshots/call-presence-incall-desktop.png', fullPage: true });
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await ownerPage.getByRole('button', { name: 'Close chat' }).click();
    await ownerPage.screenshot({ path: 'tests/screenshots/call-presence-incall-mobile.png', fullPage: true });
    await ownerPage.setViewportSize({ width: 1280, height: 900 });

    await ownerPage.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(guestPage.locator('.call-lobby')).toContainText('Muted');
    await ownerPage.getByRole('button', { name: 'Deafen call' }).click();
    await expect(guestPage.locator('.call-lobby')).toContainText('Deafened');
    await expect(guestPage.locator('.conversation-navigation').getByLabel('Deafened')).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Undeafen call' }).click();
    await expect(ownerPage.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();

    await guestPage.getByRole('button', { name: 'Join call' }).click();
    await expect(guestPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(guestPage.locator('.camera-tile:not(.self)').getByLabel('Muted')).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Deafen call' }).click();
    await expect(guestPage.locator('.camera-tile:not(.self)').getByLabel('Deafened')).toBeVisible();

    await guestPage.route('**/api/v1/call-presence*', (route) => route.abort());
    await guestPage.reload();
    await expect(guestPage.getByText('Call activity unavailable')).toBeVisible();
    await expect(guestPage.getByRole('region', { name: 'Call lobby' })).toContainText('Checking who’s here…');
    await expect(guestPage.getByText('No one has joined yet. You can be the first.')).toHaveCount(0);
  } finally {
    await Promise.allSettled([ownerContext.close(), guestContext.close()]);
  }
});
