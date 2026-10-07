import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';

type User = { id: string; name: string; email: string };
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
    response = await context.request.post('/api/v1/auth/dev', {
      headers: { Origin: origin },
      data: { name, email },
    });
    if (response.status() !== 429 || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  } while (true);
  const value = await json<User | { user: User }>(response);
  return 'user' in value ? value.user : value;
};

test('chat, call activity, and friend availability update without polling', async ({ browser }) => {
  const ownerContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  let releaseInitialRooms = () => {};
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
    const direct = await json<{ room: { id: string } }>(await ownerContext.request.post('/api/v1/rooms/direct', {
      headers: { Origin: origin }, data: { user_id: guest.id },
    }));

    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();
    const pages = [ownerPage, guestPage];
    const initialRooms = new Promise<void>(resolve => { releaseInitialRooms = resolve; });
    const heldRoomReads = [0, 0];
    await Promise.all(pages.map((page, index) => page.route(
      url => url.pathname === '/api/v1/rooms',
      async route => {
        if (route.request().method() === 'GET') {
          heldRoomReads[index] = (heldRoomReads[index] ?? 0) + 1;
          await initialRooms;
        }
        await route.continue();
      },
    )));
    let guestHistoryReads = 0;
    let presencePolls = 0;
    guestPage.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === `/api/v1/rooms/${direct.room.id}/messages`) guestHistoryReads += 1;
      if (url.pathname === '/api/v1/call-presence') presencePolls += 1;
    });
    await Promise.all([ownerPage.goto('/'), guestPage.goto('/')]);
    await Promise.all(pages.map((_, index) => expect.poll(() => heldRoomReads[index]).toBeGreaterThan(0)));
    await Promise.all(pages.map(page => page.getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Messages', exact: true }).click()));
    await Promise.all(pages.map(page => expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible()));
    // The real room list arrives after explicit navigation. Its default channel
    // selection must not move the sidebar back to Rooms during bootstrap.
    releaseInitialRooms();
    await Promise.all(pages.map(async page => {
      await expect(page.getByRole('region', { name: 'Direct messages', exact: true })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Sections' })
        .getByRole('button', { name: 'Messages', exact: true })).toHaveAttribute('aria-current', 'page');
    }));
    await Promise.all([
      ownerPage.getByRole('region', { name: 'Direct messages', exact: true })
        .getByRole('button', { name: guest.name, exact: true }).click(),
      guestPage.getByRole('region', { name: 'Direct messages', exact: true })
        .getByRole('button', { name: owner.name, exact: true }).click(),
    ]);
    await expect.poll(() => guestHistoryReads).toBeGreaterThan(0);
    const readsAfterHydration = guestHistoryReads;

    const body = `socket message ${Date.now()}`;
    const ownerConversation = ownerPage.getByRole('region', { name: `Conversation with ${guest.name}`, exact: true });
    const guestConversation = guestPage.getByRole('region', { name: `Conversation with ${owner.name}`, exact: true });
    await ownerConversation.getByRole('textbox', { name: `Message ${guest.name}`, exact: true }).fill(body);
    await ownerConversation.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(guestConversation.getByText(body)).toBeVisible({ timeout: 2_000 });
    expect(guestHistoryReads).toBe(readsAfterHydration);
    expect(presencePolls).toBe(0);

    for (const page of [ownerPage, guestPage]) {
      await page.getByRole('navigation', { name: 'Sections' })
        .getByRole('button', { name: 'Rooms', exact: true }).click();
      await page.getByRole('list', { name: `${created.room.name} channel list`, exact: true })
        .getByRole('button', { name: created.room.name, exact: true }).click();
      await expect(page.getByRole('textbox', { name: `Message ${created.room.name}`, exact: true })).toBeVisible();
    }
    await ownerPage.getByRole('region', { name: `${created.room.name} · ${created.room.name}`, exact: true })
      .getByRole('button', { name: 'Join voice', exact: true }).click();
    const voiceParticipants = guestPage.getByRole('list', { name: `${created.room.name} call participants`, exact: true });
    await expect(voiceParticipants).toContainText(owner.name, { timeout: 2_000 });
    await ownerPage.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(voiceParticipants).toContainText(`${owner.name} · muted`, { timeout: 2_000 });
    expect(presencePolls).toBe(0);

    await ownerPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Friends' }).click();
    const contact = ownerPage.getByRole('dialog').getByRole('group', { name: `Friend ${guest.name}`, exact: true });
    await expect(contact.getByText('Online', { exact: true })).toBeVisible({ timeout: 2_000 });
    await guestContext.close();
    await expect(contact.getByText('Offline', { exact: true })).toBeVisible({ timeout: 5_000 });
  } finally {
    releaseInitialRooms();
    await Promise.allSettled([ownerContext.close(), guestContext.close()]);
  }
});
