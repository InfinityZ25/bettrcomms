import {
  test,
  expect,
  type BrowserContext,
  type APIResponse,
} from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
async function value<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
type User = { id: string; name: string };
type Message = { id: string; body: string; reply?: { id: string } };
async function login(context: BrowserContext, name: string, suffix: string) {
  const result = await value<User | { user: User }>(
    await context.request.post('/api/v1/auth/dev', {
      headers,
      data: {
        name,
        email: `${name.replaceAll(' ', '-').toLowerCase()}-${suffix}@example.test`,
      },
    }),
  );
  return 'user' in result ? result.user : result;
}

test('unread mentions, older history, search and message actions work across two users', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  const outsiderContext = await browser.newContext({ baseURL });
  let directId = '';
  let privateId = '';
  let guestRoomId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const owner = await login(ownerContext, 'Messaging Ada', suffix);
    const guest = await login(guestContext, 'Messaging Grace', suffix);
    await login(outsiderContext, 'Messaging Outsider', suffix);
    const request = await value<{ request: { id: string } }>(
      await ownerContext.request.post('/api/v1/friends/requests', {
        headers,
        data: { user_id: guest.id },
      }),
    );
    await value(
      await guestContext.request.post(
        `/api/v1/friends/requests/${request.request.id}/accept`,
        { headers, data: {} },
      ),
    );
    const direct = await value<{ room: { id: string } }>(
      await ownerContext.request.post('/api/v1/rooms/direct', {
        headers,
        data: { user_id: guest.id },
      }),
    );
    directId = direct.room.id;
    const guestRoom = await value<{ room: { id: string } }>(
      await guestContext.request.post('/api/v1/rooms', {
        headers,
        data: { name: 'Other conversation' },
      }),
    );
    guestRoomId = guestRoom.room.id;
    const privateRoom = await value<{ room: { id: string } }>(
      await outsiderContext.request.post('/api/v1/rooms', {
        headers,
        data: { name: 'Private conversation' },
      }),
    );
    privateId = privateRoom.room.id;
    const seeded: Message[] = [];
    for (let index = 0; index < 60; index++) {
      const result = await value<{ message: Message }>(
        await ownerContext.request.post(`/api/v1/rooms/${directId}/messages`, {
          headers,
          data: {
            body: `history ${index} needle${index === 59 ? ` <@${guest.id}>` : ''}`,
          },
        }),
      );
      seeded.push(result.message);
    }
    await value(
      await guestContext.request.post(`/api/v1/rooms/${guestRoomId}/messages`, {
        headers,
        data: { body: 'Keep this conversation selected while searching history' },
      }),
    );
    await value(
      await outsiderContext.request.post(
        `/api/v1/rooms/${privateId}/messages`,
        { headers, data: { body: 'secret needle never visible' } },
      ),
    );
    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();
    await ownerPage.goto('/');
    await guestPage.goto('/');
    await guestPage
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Messages', exact: true })
      .click();
    await expect(
      guestPage.getByLabel('60 unread messages, 1 mentions'),
    ).toBeVisible();
    let automaticReads = 0;
    guestPage.on('request', (request) => {
      if (
        request.method() === 'PUT' &&
        new URL(request.url()).pathname === `/api/v1/rooms/${directId}/read`
      )
        automaticReads++;
    });
    await guestPage
      .getByRole('button', { name: 'Search all messages', exact: true })
      .click();
    const oldSearch = guestPage.getByRole('dialog');
    await oldSearch
      .getByRole('searchbox', { name: 'Search messages', exact: true })
      .fill('"history 0 needle"');
    await oldSearch
      .getByRole('button', { name: 'Search', exact: true })
      .click();
    await oldSearch.getByText('history 0 needle', { exact: true }).click();
    await expect(
      guestPage.locator(`[data-message-id="${seeded[0].id}"]`),
    ).toBeVisible();
    await expect(
      guestPage.getByText(
        'Earlier message — load older messages for surrounding history.',
        { exact: true },
      ),
    ).toBeVisible();
    const afterSearch = await value<{
      rooms: { room_id: string; unread: number }[];
    }>(await guestContext.request.get('/api/v1/messages/unread'));
    expect(
      afterSearch.rooms.find((room) => room.room_id === directId)?.unread,
    ).toBe(60);
    expect(automaticReads).toBe(0);
    await guestPage
      .getByRole('button', { name: owner.name, exact: true })
      .click();
    await expect(
      guestPage.getByText('history 59 needle', { exact: false }),
    ).toBeVisible();
    await expect(guestPage.getByRole('log')).toContainText(`@${guest.name}`);
    await guestPage
      .getByRole('button', { name: 'Mark as read', exact: true })
      .click();
    await expect
      .poll(async () => {
        const state = await value<{
          rooms: { room_id: string; unread: number }[];
        }>(await guestContext.request.get('/api/v1/messages/unread'));
        return state.rooms.find((room) => room.room_id === directId)?.unread;
      })
      .toBe(0);
    await guestPage
      .getByRole('button', { name: 'Load older messages', exact: true })
      .click();
    await expect(
      guestPage.getByText('history 0 needle', { exact: true }),
    ).toBeVisible();
    await expect(
      guestPage.getByRole('button', {
        name: 'Load older messages',
        exact: true,
      }),
    ).toHaveCount(0);

    await ownerPage
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Messages', exact: true })
      .click();
    await ownerPage
      .getByRole('button', { name: guest.name, exact: true })
      .click();
    const composer = ownerPage.getByRole('textbox', {
      name: `Message ${guest.name}`,
      exact: true,
    });
    await composer.fill('new message @Messaging Gr');
    await ownerPage
      .getByRole('option', { name: guest.name, exact: false })
      .click();
    await ownerPage
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const current = await value<{ messages: Message[] }>(
      await ownerContext.request.get(`/api/v1/rooms/${directId}/messages`),
    );
    const sent = current.messages.at(-1)!;
    const ownerMessage = ownerPage.locator(`[data-message-id="${sent.id}"]`);
    const guestMessage = guestPage.locator(`[data-message-id="${sent.id}"]`);
    await expect(guestMessage).toContainText(`@${guest.name}`);
    let historyReads = 0;
    guestPage.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        new URL(request.url()).pathname === `/api/v1/rooms/${directId}/messages`
      )
        historyReads += 1;
    });
    await ownerMessage
      .getByRole('button', { name: 'Edit message', exact: true })
      .click();
    await composer.fill('edited message needle');
    await ownerPage
      .getByRole('button', { name: 'Save message', exact: true })
      .click();
    await expect(guestMessage.locator('[data-message-body]')).toHaveText('edited message needle');
    await expect(guestMessage).toContainText('edited');
    expect(historyReads).toBe(0);
    await guestMessage
      .getByRole('button', { name: `Reply to ${owner.name}`, exact: true })
      .click();
    await guestPage
      .getByRole('textbox', { name: `Message ${owner.name}`, exact: true })
      .fill('reply from Grace needle');
    await guestPage
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      ownerPage.getByText('reply from Grace needle', { exact: true }),
    ).toBeVisible();
    await ownerMessage
      .getByRole('button', { name: 'Add reaction', exact: true })
      .click();
    const picker = ownerPage.getByRole('dialog', { name: 'Choose emoji', exact: true });
    await picker.getByRole('searchbox', { name: 'Search emojis', exact: true }).fill('thumbs up');
    await picker.getByRole('button', { name: 'Emoji thumbs up', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(
      guestMessage.getByRole('button', { name: 'React 👍, 1', exact: true }),
    ).toBeVisible();
    await ownerMessage
      .getByRole('button', { name: 'React 👍, 1', exact: true })
      .click();
    await expect(
      guestMessage.getByRole('button', { name: /React 👍/ }),
    ).toHaveCount(0);
    await ownerMessage
      .getByRole('button', { name: 'Delete message', exact: true })
      .click();
    await ownerMessage
      .getByRole('button', { name: 'Confirm delete', exact: true })
      .click();
    await expect(guestMessage).toContainText('Message deleted');
    await expect(
      guestPage.getByRole('button', {
        name: `Go to reply from ${owner.name}`,
        exact: true,
      }),
    ).toContainText('Message deleted');
    await expect(
      guestMessage.getByRole('button', { name: 'Edit message' }),
    ).toHaveCount(0);

    await guestPage
      .getByRole('button', { name: 'Search all messages', exact: true })
      .click();
    const dialog = guestPage.getByRole('dialog');
    await dialog
      .getByRole('searchbox', { name: 'Search messages', exact: true })
      .fill('needle');
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(
      dialog.getByText('reply from Grace needle', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText('secret needle never visible', { exact: true }),
    ).toHaveCount(0);
    await dialog
      .getByRole('button', { name: 'More results', exact: true })
      .click();
    await expect(
      dialog.getByText('history 1 needle', { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole('button', { name: 'More results', exact: true })
      .click();
    await expect(
      dialog.getByText('history 0 needle', { exact: true }),
    ).toBeVisible();
    await dialog
      .getByLabel('Search author', { exact: true })
      .selectOption(guest.id);
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(
      dialog.getByText('reply from Grace needle', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText('history 59 needle', { exact: false }),
    ).toHaveCount(0);
    await dialog.getByText('reply from Grace needle', { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      guestPage.getByText('reply from Grace needle', { exact: true }),
    ).toBeVisible();
    await guestPage.reload();
    await guestPage
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Messages', exact: true })
      .click();
    await guestPage
      .getByRole('button', { name: owner.name, exact: true })
      .click();
    await expect(
      guestPage.locator(`[data-message-id="${sent.id}"]`),
    ).toContainText('Message deleted');
  } finally {
    await Promise.allSettled([
      ...(guestRoomId ? [guestContext.request.delete(`/api/v1/rooms/${guestRoomId}`, { headers, timeout: 5000 })] : []),
      ...(privateId ? [outsiderContext.request.delete(`/api/v1/rooms/${privateId}`, { headers, timeout: 5000 })] : []),
    ]);
    await Promise.allSettled([
      ownerContext.close(),
      guestContext.close(),
      outsiderContext.close(),
    ]);
  }
});

test('room chat works without joining a call and opens distant search hits safely', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
  });
  let roomId = '';
  try {
    await login(context, 'Channel Messaging', `${Date.now()}`);
    roomId = (
      await value<{ room: { id: string } }>(
        await context.request.post('/api/v1/rooms', {
          headers,
          data: { name: 'Messaging channel' },
        }),
      )
    ).room.id;
    let anchorId = '';
    for (let index = 0; index < 55; index++) {
      const result = await value<{ message: Message }>(
        await context.request.post(`/api/v1/rooms/${roomId}/messages`, {
          headers,
          data: {
            body: index ? `channel history ${index}` : 'distant search anchor',
          },
        }),
      );
      if (!index) anchorId = result.message.id;
    }
    const page = await context.newPage();
    const crashes: string[] = [];
    page.on('pageerror', (error) => crashes.push(error.message));
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Messaging channel', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Toggle room messages', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Leave call', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText('channel history 54', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Search this conversation', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('searchbox', { name: 'Search messages', exact: true })
      .fill('distant');
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    await dialog.getByText('distant search anchor', { exact: true }).click();
    const anchor = page.locator(`[data-message-id="${anchorId}"]`);
    await expect(anchor).toContainText('distant search anchor');
    await expect(
      page.getByText(
        'Earlier message — load older messages for surrounding history.',
        { exact: true },
      ),
    ).toBeVisible();
    await value(
      await context.request.patch(
        `/api/v1/rooms/${roomId}/messages/${anchorId}`,
        { headers, data: { body: 'distant anchor edited' } },
      ),
    );
    await expect(anchor).toContainText('distant anchor edited');
    await page.route(`**/rooms/${roomId}/read`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'unavailable',
            message: 'Read temporarily unavailable',
          },
        }),
      }),
    );
    // A later message has not yet been marked read, so the explicit action sends a request.
    await value(
      await context.request.post(`/api/v1/rooms/${roomId}/messages`, {
        headers,
        data: { body: 'new channel message' },
      }),
    );
    await page
      .getByRole('button', { name: 'Mark as read', exact: true })
      .click();
    await expect(
      page.getByText('Read temporarily unavailable', { exact: true }),
    ).toBeVisible();
    expect(crashes).toEqual([]);
  } finally {
    if (roomId)
      await context.request.delete(`/api/v1/rooms/${roomId}`, { headers });
    await context.close();
  }
});
