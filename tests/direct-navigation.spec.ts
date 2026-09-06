import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';

type User = { id: string; name: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;
async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function login(context: BrowserContext, name: string, email: string) {
  // The whole suite shares the real loopback auth limiter. Respect its window.
  const deadline = Date.now() + 65_000;
  let response: APIResponse;
  for (;;) {
    response = await context.request.post('/api/v1/auth/dev', {
      headers: { Origin: origin }, data: { name, email },
    });
    if (response.status() !== 429 || Date.now() >= deadline) break;
    await response.dispose();
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  const value = await json<User | { user: User }>(response);
  return 'user' in value ? value.user : value;
}

test('direct rooms use the other friend name and share call presence', async ({ browser }) => {
  test.setTimeout(150_000);
  const adaContext = await browser.newContext({ baseURL });
  const graceContext = await browser.newContext({ baseURL });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ada = await login(adaContext, 'Direct Ada', `direct-ada-${suffix}@example.test`);
    const grace = await login(graceContext, 'Direct Grace', `direct-grace-${suffix}@example.test`);
    const request = await json<{ request: { id: string } }>(await adaContext.request.post('/api/v1/friends/requests', {
      headers: { Origin: origin }, data: { user_id: grace.id },
    }));
    await json(await graceContext.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, {
      headers: { Origin: origin }, data: {},
    }));
    await json(await adaContext.request.post('/api/v1/rooms/direct', {
      headers: { Origin: origin }, data: { user_id: grace.id },
    }));

    const adaPage = await adaContext.newPage();
    const gracePage = await graceContext.newPage();
    await Promise.all([adaPage.goto('/'), gracePage.goto('/')]);
    for (const page of [adaPage, gracePage]) {
      await expect(page.getByRole('region', { name: 'Rooms' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Direct messages' })).toBeVisible();
    }
    await expect(adaPage.getByRole('button', { name: 'Direct Grace' })).toBeVisible();
    await expect(gracePage.getByRole('button', { name: 'Direct Ada' })).toBeVisible();
    await adaPage.getByRole('button', { name: 'Direct Grace' }).click();
    await gracePage.getByRole('button', { name: 'Direct Ada' }).click();
    await expect(adaPage.getByRole('heading', { name: 'Direct Grace' })).toBeVisible();
    await expect(gracePage.getByRole('heading', { name: 'Direct Ada' })).toBeVisible();

    await adaPage.getByRole('button', { name: 'Join call' }).click();
    await expect(adaPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    const graceLobby = gracePage.getByRole('region', { name: 'Call lobby' });
    await expect(graceLobby).toContainText('Direct Ada');
    await expect(gracePage.getByRole('list', { name: 'Direct Ada call participants' })).toContainText('Direct Ada');
    await adaPage.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(graceLobby).toContainText('Muted');
  } finally {
    await Promise.allSettled([adaContext.close(), graceContext.close()]);
  }
});
