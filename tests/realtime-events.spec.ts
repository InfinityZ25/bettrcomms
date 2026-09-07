import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';

type User = { id: string; name: string; email: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;
const json = async <T>(response: APIResponse) => {
  if (!response.ok()) throw new Error(await response.text());
  return response.json() as Promise<T>;
};
const login = async (context: BrowserContext, name: string, email: string) => {
  const response = await context.request.post('/api/v1/auth/dev', {
    headers: { Origin: origin },
    data: { name, email },
  });
  const value = await json<User | { user: User }>(response);
  return 'user' in value ? value.user : value;
};

test('chat, call activity, and friend availability update without polling', async ({ browser }) => {
  const ownerContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const owner = await login(ownerContext, 'Realtime Ada', `realtime-ada-${suffix}@example.test`);
    const guest = await login(guestContext, 'Realtime Grace', `realtime-grace-${suffix}@example.test`);
    const request = await json<{ request: { id: string } }>(await ownerContext.request.post('/api/v1/friends/requests', {
      headers: { Origin: origin }, data: { user_id: guest.id },
    }));
    await json(await guestContext.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, {
      headers: { Origin: origin }, data: {},
    }));
    const created = await json<{ room: { id: string; name: string } }>(await ownerContext.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: 'Realtime room' },
    }));
    await json(await ownerContext.request.post(`/api/v1/rooms/${created.room.id}/members`, {
      headers: { Origin: origin }, data: { user_id: guest.id },
    }));

    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();
    let guestHistoryReads = 0;
    let presencePolls = 0;
    guestPage.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === `/api/v1/rooms/${created.room.id}/messages`) guestHistoryReads += 1;
      if (url.pathname === '/api/v1/call-presence') presencePolls += 1;
    });
    await Promise.all([ownerPage.goto('/'), guestPage.goto('/')]);
    await Promise.all([
      ownerPage.getByRole('button', { name: created.room.name }).click(),
      guestPage.getByRole('button', { name: created.room.name }).click(),
    ]);
    await expect.poll(() => guestHistoryReads).toBeGreaterThan(0);
    const readsAfterHydration = guestHistoryReads;

    const body = `socket message ${Date.now()}`;
    await ownerPage.getByRole('textbox', { name: /message your room/i }).fill(body);
    await ownerPage.getByRole('button', { name: /send message/i }).click();
    await expect(guestPage.getByText(body)).toBeVisible({ timeout: 2_000 });
    expect(guestHistoryReads).toBe(readsAfterHydration);
    expect(presencePolls).toBe(0);

    await ownerPage.getByRole('button', { name: 'Join call' }).click();
    await expect(guestPage.locator('.call-lobby')).toContainText(owner.name, { timeout: 2_000 });
    await ownerPage.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(guestPage.locator('.call-lobby')).toContainText('Muted', { timeout: 2_000 });
    expect(presencePolls).toBe(0);

    await ownerPage.locator('.nav-item').filter({ hasText: 'Friends' }).click();
    await expect(ownerPage.getByText(`Online · ${guest.email}`)).toBeVisible({ timeout: 2_000 });
    await guestContext.close();
    await expect(ownerPage.getByText(`Offline · ${guest.email}`)).toBeVisible({ timeout: 5_000 });
  } finally {
    await Promise.allSettled([ownerContext.close(), guestContext.close()]);
  }
});
