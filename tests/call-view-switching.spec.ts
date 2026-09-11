import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

type User = { id: string; name: string };
type Room = { id: string; name: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()} ${response.url()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = await json<User | { user: User }>(await context.request.post('/api/v1/auth/dev', {
    headers: { Origin: origin }, data: { name: 'Views Ada', email: `views-${suffix}@example.test` },
  }));
  return 'user' in body ? body.user : body;
}

async function createRoom(context: BrowserContext, name: string) {
  return (await json<{ room: Room }>(await context.request.post('/api/v1/rooms', {
    headers: { Origin: origin }, data: { name },
  }))).room;
}

/**
 * Navigation must go through the UI. A `page.goto` to another hash reloads the
 * document, which would end the call for a reason that has nothing to do with
 * what these tests are about.
 */
async function openScreen(page: Page, screen: 'recordings' | 'settings') {
  const label = screen === 'settings' ? 'Audio and video settings' : 'Recordings';
  await page.getByRole('button', { name: label }).click();
  await expect(page.getByRole('main', { name: screen === 'settings' ? 'Settings' : 'Recordings' })).toBeVisible();
}

async function backToCall(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/#\/$/);
}

/**
 * The call belongs to the application, not to the call screen.
 *
 * CallSessionProvider owns the session above the screen tree, so opening
 * Recordings or Settings hides the call and never unmounts it. The mute state is
 * the witness: it lives in the session, so one that was torn down and rebuilt
 * would come back unmuted even though "Leave call" looks the same.
 */
test('the call survives every screen change', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  try {
    await login(context);
    const room = await createRoom(context, 'View switching');

    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: room.name }).click();
    await page.getByRole('button', { name: 'Join call' }).click();
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();

    await page.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();

    const shell = page.locator('[data-app-shell]');
    for (const screen of ['recordings', 'settings'] as const) {
      await openScreen(page, screen);
      // The call is still live while another screen is on top of it.
      await expect(shell).toHaveAttribute('data-in-call', 'true');
      await backToCall(page);
      await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
      // Still the same session: a rebuilt one would have forgotten the mute.
      await expect(page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

/**
 * Browsing another room while a call is live must not move or end the call. The
 * session is pinned to the room it was joined in, and the header offers the way
 * back rather than dragging the call along.
 */
test('browsing another room leaves the call in the room it started in', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  try {
    await login(context);
    const room = await createRoom(context, 'Call home');
    const otherRoom = await createRoom(context, 'Just browsing');

    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: room.name }).click();
    await page.getByRole('button', { name: 'Join call' }).click();
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await page.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();

    await page.getByRole('button', { name: otherRoom.name }).click();
    await expect(page.locator('.room-heading strong')).toHaveText(otherRoom.name);
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();

    // Opening a screen from the other room still does not disturb the call.
    await openScreen(page, 'recordings');
    await backToCall(page);
    await expect(page.getByRole('button', { name: `Return to ${room.name}` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
  } finally {
    await context.close();
  }
});
