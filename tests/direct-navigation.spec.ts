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
      await page.getByRole('button', { name: 'Messages', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Direct messages' })).toBeVisible();
    }
    await expect(adaPage.getByRole('button', { name: 'Direct Grace', exact: true })).toBeVisible();
    await expect(gracePage.getByRole('button', { name: 'Direct Ada', exact: true })).toBeVisible();
    await adaPage.getByRole('button', { name: 'Direct Grace', exact: true }).click();
    await gracePage.getByRole('button', { name: 'Direct Ada', exact: true }).click();
    const adaConversation = adaPage.getByRole('region', { name: 'Conversation with Direct Grace', exact: true });
    const graceConversation = gracePage.getByRole('region', { name: 'Conversation with Direct Ada', exact: true });
    await expect(adaConversation.locator('header')).toContainText('Direct Grace');
    await expect(graceConversation.locator('header')).toContainText('Direct Ada');

    await adaConversation.getByRole('button', { name: 'Call', exact: true }).click();
    await expect(adaPage.getByRole('button', { name: 'Leave call' })).toBeVisible();
    // The conversation stays open rather than being replaced by a call lobby.
    await expect(graceConversation).toBeVisible();
    const graceParticipants = gracePage.getByRole('list', { name: 'Direct Ada call participants' });
    await expect(graceParticipants).toContainText('Direct Ada');
    await adaPage.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(graceParticipants.getByRole('img', { name: 'Muted', exact: true })).toBeVisible();
    await adaPage.getByRole('button', { name: 'Leave call' }).click();
    await expect(graceParticipants).toHaveCount(0);
  } finally {
    await Promise.allSettled([adaContext.close(), graceContext.close()]);
  }
});

test('signing into another account without reloading restores its default Rooms section', async ({ browser }) => {
  test.setTimeout(150_000);
  const firstContext = await browser.newContext({ baseURL });
  const secondContext = await browser.newContext({ baseURL });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const secondEmail = `section-second-${suffix}@example.test`;
    const second = await login(secondContext, 'Second Section Account', secondEmail);
    const { room } = await json<{ room: { name: string } }>(await secondContext.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: `Second account room ${suffix}` },
    }));
    const first = await login(firstContext, 'First Section Account', `section-first-${suffix}@example.test`);
    const page = await firstContext.newPage();
    await page.goto('/');
    const sections = page.getByRole('navigation', { name: 'Sections' });
    await expect(sections.getByRole('button', { name: `${first.name} and account options`, exact: true })).toBeVisible();
    await sections.getByRole('button', { name: 'Messages', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
    await page.evaluate((value) => {
      (window as unknown as { sectionAccountDocument: string }).sectionAccountDocument = value;
    }, suffix);

    await sections.getByRole('button', { name: `${first.name} and account options`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Enter local workspace', exact: true })).toBeVisible();
    expect((await firstContext.request.get('/api/v1/me')).status()).toBe(401);
    await page.getByRole('textbox', { name: 'Your name', exact: true }).fill(second.name);
    await page.getByRole('textbox', { name: 'Your email', exact: true }).fill(secondEmail);

    const deadline = Date.now() + 65_000;
    for (;;) {
      const [response] = await Promise.all([
        page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/v1/auth/dev'),
        page.getByRole('button', { name: 'Enter local workspace', exact: true }).click(),
      ]);
      if (response.status() !== 429 || Date.now() >= deadline) {
        expect(response.ok(), `Local sign-in status ${response.status()}`).toBeTruthy();
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    await expect(sections.getByRole('button', { name: `${second.name} and account options`, exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: `${room.name} channel list`, exact: true })).toBeVisible();
    await expect(sections.getByRole('button', { name: 'Rooms', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(sections.getByRole('button', { name: 'Messages', exact: true })).not.toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => (window as unknown as { sectionAccountDocument: string }).sectionAccountDocument)).toBe(suffix);
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close()]);
  }
});

for (const removedSection of ['Rooms', 'Messages'] as const) {
  const fallbackSection = removedSection === 'Rooms' ? 'Messages' : 'Rooms';
  test(`membership removal follows the fallback conversation from ${removedSection} to ${fallbackSection} without reloading`, async ({ browser }) => {
    test.setTimeout(150_000);
    const ownerContext = await browser.newContext({ baseURL });
    const peerContext = await browser.newContext({ baseURL });
    const roomIds: string[] = [];
    try {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await login(ownerContext, 'Fallback Owner', `fallback-owner-${suffix}@example.test`);
      const peer = await login(peerContext, 'Fallback Peer', `fallback-peer-${suffix}@example.test`);
      const { request } = await json<{ request: { id: string } }>(await ownerContext.request.post('/api/v1/friends/requests', {
        headers: { Origin: origin }, data: { user_id: peer.id },
      }));
      await json(await peerContext.request.post(`/api/v1/friends/requests/${request.id}/accept`, {
        headers: { Origin: origin }, data: {},
      }));
      type Room = { id: string; name: string; community_name?: string };
      const { room: channel } = await json<{ room: Room }>(await ownerContext.request.post('/api/v1/rooms', {
        headers: { Origin: origin }, data: { name: `Fallback channel ${suffix}` },
      }));
      roomIds.push(channel.id);
      await json(await ownerContext.request.post(`/api/v1/rooms/${channel.id}/members`, {
        headers: { Origin: origin }, data: { user_id: peer.id },
      }));
      const { room: group } = await json<{ room: Room }>(await ownerContext.request.post('/api/v1/rooms/group', {
        headers: { Origin: origin }, data: { name: `Fallback group ${suffix}`, user_ids: [peer.id] },
      }));
      roomIds.push(group.id);
      const removed = removedSection === 'Rooms' ? channel : group;
      const fallback = removedSection === 'Rooms' ? group : channel;
      const page = await peerContext.newPage();
      await page.goto('/');
      const sections = page.getByRole('navigation', { name: 'Sections' });
      await sections.getByRole('button', { name: removedSection, exact: true }).click();
      const roomList = (room: Room, section: 'Rooms' | 'Messages') => section === 'Rooms'
        ? page.getByRole('list', { name: `${room.community_name ?? room.name} channel list`, exact: true })
        : page.getByRole('region', { name: 'Direct messages', exact: true });
      const conversation = (room: Room, section: 'Rooms' | 'Messages') => page.getByRole('region', {
        name: section === 'Rooms' ? `${room.community_name ?? 'Room'} · ${room.name}` : `Conversation with ${room.name}`,
        exact: true,
      });
      await roomList(removed, removedSection).getByRole('button', { name: removed.name, exact: true }).click();
      await expect(conversation(removed, removedSection)).toBeVisible();
      await expect(sections.getByRole('button', { name: removedSection, exact: true })).toHaveAttribute('aria-current', 'page');
      await page.evaluate((value) => {
        (window as unknown as { membershipFallbackDocument: string }).membershipFallbackDocument = value;
      }, suffix);

      await json(await ownerContext.request.delete(`/api/v1/rooms/${removed.id}/members/${peer.id}`, {
        headers: { Origin: origin },
      }));
      expect((await peerContext.request.get(`/api/v1/rooms/${removed.id}`)).status()).toBe(403);
      await expect(conversation(removed, removedSection)).toHaveCount(0);
      await expect(conversation(fallback, fallbackSection)).toBeVisible();
      await expect(sections.getByRole('button', { name: fallbackSection, exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(sections.getByRole('button', { name: removedSection, exact: true })).not.toHaveAttribute('aria-current', 'page');
      await expect(roomList(fallback, fallbackSection).getByRole('button', { name: fallback.name, exact: true })).toHaveAttribute('aria-current', 'page');
      expect(await page.evaluate(() => (window as unknown as { membershipFallbackDocument: string }).membershipFallbackDocument)).toBe(suffix);
    } finally {
      for (const roomId of roomIds) await ownerContext.request.delete(`/api/v1/rooms/${roomId}`, { headers: { Origin: origin } });
      await Promise.allSettled([ownerContext.close(), peerContext.close()]);
    }
  });
}
