import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { openSettingsCategory } from './settings-navigation';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string };
type Room = { id: string };

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext, name: string, email: string) {
  const deadline = Date.now() + 65_000;
  for (;;) {
    const response = await context.request.post('/api/v1/auth/dev', { headers, data: { name, email } });
    if (response.status() !== 429 || Date.now() >= deadline) {
      const result = await json<User | { user: User }>(response);
      return 'user' in result ? result.user : result;
    }
    await response.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function directConversation(owner: BrowserContext, peer: BrowserContext, peerUser: User) {
  const request = await json<{ request: { id: string } }>(await owner.request.post('/api/v1/friends/requests', { headers, data: { user_id: peerUser.id } }));
  await json(await peer.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, { headers, data: {} }));
  const { room } = await json<{ room: Room }>(await owner.request.post('/api/v1/rooms/direct', { headers, data: { user_id: peerUser.id } }));
  await json(await peer.request.post(`/api/v1/rooms/${room.id}/messages`, { headers, data: { body: 'Say hi to my companion' } }));
  return room;
}

async function openConversation(page: Page, other: User) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
  await page.getByRole('region', { name: 'Direct messages', exact: true }).getByRole('button', { name: other.name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: `Message ${other.name}`, exact: true })).toBeVisible();
}

const companion = (page: Page) => page.locator('.pet:not(.pet-visitor)');

/** Animations the companion is running right now, including CSS ones under it. */
const runningAnimations = (page: Page) => companion(page).evaluate((node) =>
  node.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length);

test('the screen companion perches, reacts, hosts a visiting friend and stops when unseen', async ({ browser }, testInfo) => {
  test.setTimeout(150_000);
  const owner = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const peer = await browser.newContext({ baseURL });
  let roomId = '';
  try {
    const suffix = `${Date.now()}-${testInfo.workerIndex}`;
    const me = await login(owner, 'Companion Owner', `screen-companion-${suffix}@example.test`);
    const friend = await login(peer, 'Companion Friend', `screen-companion-friend-${suffix}@example.test`);
    roomId = (await directConversation(owner, peer, friend)).id;
    const page = await owner.newPage();
    await openConversation(page, friend);

    // It stands on the composer's top edge, inside the reserved activity row.
    const pet = companion(page);
    await expect(pet).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
    await expect(pet).toHaveAttribute('data-companion-user', me.id);
    const composer = page.locator('[data-pet-perch="composer"]');
    await expect.poll(async () => {
      const [feet, edge] = await Promise.all([pet.boundingBox(), composer.boundingBox()]);
      return feet && edge ? Math.abs(feet.y + feet.height - edge.y) : Infinity;
    }, { timeout: 10_000 }).toBeLessThan(3);

    // Booping it changes its face; the reaction relaxes on its own.
    await expect(pet).toHaveAttribute('data-expr', 'idle', { timeout: 8000 });
    const hit = await page.locator('.pet-hit').first().boundingBox();
    await page.mouse.click(hit!.x + hit!.width / 2, hit!.y + hit!.height / 2);
    await expect(pet).not.toHaveAttribute('data-expr', 'idle');
    await expect(pet).toHaveAttribute('data-expr', 'idle', { timeout: 6000 });

    // A mention is the loudest thing that can happen.
    await page.mouse.move(400, 300);
    await json(await peer.request.post(`/api/v1/rooms/${roomId}/messages`, { headers, data: { body: `<@${me.id}> look` } }));
    await expect(pet).toHaveAttribute('data-expr', 'surprised');
    await expect(pet.locator('.pet-emote-exclaim')).toHaveCount(1);
    await expect(pet).toHaveAttribute('data-expr', 'idle', { timeout: 6000 });

    // A friend's gesture brings their creature over for a visit, and it leaves again.
    const sent = await peer.request.post(`/api/v1/rooms/${roomId}/character-gesture`, { headers, data: { gesture: 'wave' } });
    expect(sent.ok()).toBe(true);
    const visitor = page.locator('.pet-visitor');
    await expect(visitor).toHaveCount(1);
    await expect(visitor).toHaveAttribute('data-ready', 'true');
    await expect(visitor).toHaveCount(0, { timeout: 12_000 });

    // Settled, it asks for nothing: no animation runs between bursts.
    await expect.poll(() => runningAnimations(page), { timeout: 12_000, intervals: [100] }).toBe(0);

    // Unseen, it is a still drawing with nothing running and nothing queued.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(pet).toHaveAttribute('data-frozen', 'true');
    expect(await runningAnimations(page)).toBe(0);
    await json(await peer.request.post(`/api/v1/rooms/${roomId}/messages`, { headers, data: { body: `<@${me.id}> while you were away` } }));
    await page.waitForTimeout(800);
    await expect(pet).toHaveAttribute('data-expr', 'idle');
    expect(await runningAnimations(page)).toBe(0);
    // Coming back shows the one thing worth knowing.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(pet).toHaveAttribute('data-frozen', 'false');
    await expect(pet).toHaveAttribute('data-expr', 'surprised');

    // Each creature's temperament is shown where it is chosen.
    const settings = await openSettingsCategory(page, 'Profile');
    await expect(settings.getByTestId('character-temperament')).toContainText('signature move');
    await openSettingsCategory(page, 'Appearance');
    // Motion off still shows reactions, without CSS emotes or voice/body movement.
    await settings.getByRole('switch', { name: 'Character motion', exact: true }).click();
    await expect(pet).toHaveAttribute('data-still', 'true');
    await expect.poll(() => runningAnimations(page)).toBe(0);
    await json(await peer.request.post(`/api/v1/rooms/${roomId}/messages`, { headers, data: { body: `<@${me.id}> a quiet reaction` } }));
    await expect(pet).toHaveAttribute('data-expr', 'surprised');
    expect(await runningAnimations(page)).toBe(0);
    await pet.evaluate((node) => { (node as HTMLElement).dataset.talking = 'true'; });
    expect(await runningAnimations(page)).toBe(0);
    // Switching it off removes it from this device.
    await settings.getByRole('switch', { name: 'Screen companion', exact: true }).click();
    await expect(companion(page)).toHaveCount(0);
    await expect(page.evaluate(() => localStorage.getItem('bc-pet'))).resolves.toBe('off');
  } finally {
    if (roomId) await Promise.allSettled([owner.request.delete(`/api/v1/rooms/${roomId}`, { headers, timeout: 5000 })]);
    await owner.close();
    await peer.close();
  }
});
