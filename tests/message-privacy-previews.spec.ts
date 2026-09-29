import { test, expect, type APIResponse, type BrowserContext } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
async function value<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function login(context: BrowserContext, name: string, suffix: string) {
  return value<{ user: { id: string } }>(await context.request.post('/api/v1/auth/dev', {
    headers,
    data: { name, email: `${name}-${suffix}@example.test` },
  })).then((response) => response.user);
}

test('message requests, safe links and blocking stay consistent across accounts', async ({ browser }) => {
  const sender = await browser.newContext({ baseURL });
  const receiver = await browser.newContext({ baseURL });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const alice = await login(sender, 'privacy-alice', suffix);
    const bob = await login(receiver, 'privacy-bob', suffix);
    const privateResult = await value<{ allow_dm_requests: boolean }>(await receiver.request.get('/api/v1/privacy'));
    expect(privateResult.allow_dm_requests).toBe(false);
    const denied = await sender.request.post('/api/v1/dm-requests', { headers, data: { user_id: bob.id, body: 'hello' } });
    expect(denied.status()).toBe(403);
    await value(await receiver.request.put('/api/v1/privacy', { headers, data: { allow_dm_requests: true } }));
    const request = await value<{ request: { id: string } }>(await sender.request.post('/api/v1/dm-requests', {
      headers, data: { user_id: bob.id, body: 'hello' },
    }));
    const accepted = await value<{ room: { id: string } }>(await receiver.request.post(`/api/v1/dm-requests/${request.request.id}/accept`, { headers, data: {} }));
    const roomId = accepted.room.id;
    await value(await sender.request.post(`/api/v1/rooms/${roomId}/messages`, {
      headers, data: { body: 'See https://example.com/help, not javascript:alert(1) <img src=x>' },
    }));
    const page = await receiver.newPage();
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
    await page.getByRole('button', { name: 'privacy-alice', exact: true }).click();
    const link = page.getByRole('link', { name: 'https://example.com/help' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.getByRole('link', { name: /javascript:/ })).toHaveCount(0);
    await value(await receiver.request.post(`/api/v1/privacy/blocks/${alice.id}`, { headers, data: {} }));
    await expect.poll(async () => (await receiver.request.get(`/api/v1/rooms/${roomId}`)).status()).toBe(403);
    await expect.poll(async () => {
      const rooms = await value<{ rooms: { id: string }[] }>(await receiver.request.get('/api/v1/rooms'));
      return rooms.rooms.some((room) => room.id === roomId);
    }).toBe(false);
  } finally {
    await sender.close();
    await receiver.close();
  }
});
