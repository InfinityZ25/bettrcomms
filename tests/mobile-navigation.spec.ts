import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';

type User = { id: string; name: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext, name: string, email: string): Promise<User> {
  const deadline = Date.now() + 65_000;
  for (;;) {
    const response = await context.request.post('/api/v1/auth/dev', {
      headers: { Origin: origin }, data: { name, email },
    });
    if (response.status() !== 429 || Date.now() >= deadline) {
      const value = await json<User | { user: User }>(response);
      return 'user' in value ? value.user : value;
    }
    await response.dispose();
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
}

test('mobile sidebar overlays the call and closes after choosing a room', async ({ browser }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 650 } });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(context, 'Mobile Nav', `mobile-nav-${suffix}@example.test`);
    const room = (await json<{ room: { name: string } }>(await context.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: `Mobile room ${suffix}` },
    }))).room;
    const page = await context.newPage();
    await page.goto('/');
    const main = page.locator('main');
    const before = await main.boundingBox();
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    const drawer = page.getByRole('dialog', { name: 'Conversations' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toBeInViewport({ ratio: 0.9 });
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(390 * 0.64);
    expect(box!.width).toBeLessThan(390 * 0.69);
    expect((await main.boundingBox())?.width).toBe(before?.width);
    await page.screenshot({ path: '.local/mobile-sidebar-drawer.png' });
    await drawer.getByRole('button', { name: room.name }).click();
    await expect(drawer).toBeHidden();
    await expect(main.getByText(room.name).first()).toBeVisible();

    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // The 768–820px range must use the same drawer as narrower phones.
    await page.setViewportSize({ width: 800, height: 650 });
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await expect(drawer).toBeVisible();
    expect((await drawer.boundingBox())?.width).toBeGreaterThan(800 * 0.64);
  } finally {
    await context.close();
  }
});

test('friends dialog stays within a short phone viewport and scrolls to its actions', async ({ browser }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 480 } });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(context, 'Mobile Friends', `mobile-friends-${suffix}@example.test`);
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Friends', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Better with friends' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(480);
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeInViewport();
    await page.screenshot({ path: '.local/mobile-friends-dialog.png' });
    const addById = dialog.getByText('Add by user ID');
    await addById.scrollIntoViewIfNeeded();
    await expect(addById).toBeInViewport();
    await addById.click();
    await dialog.getByRole('button', { name: 'Send request' }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: 'Send request' })).toBeInViewport();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await context.close();
  }
});
