import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { openSettingsCategory } from './settings-navigation';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
test.use({ actionTimeout: 20000 });
type User = { id: string; name: string };
type Message = { id: string; body: string; attachments?: { id: string }[] };
async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function login(context: BrowserContext, name: string, suffix: string) {
  return (
    await result<{ user: User }>(
      await context.request.post('/api/v1/auth/dev', {
        headers,
        data: {
          name,
          email: `${name.replaceAll(' ', '-')}-${suffix}@example.test`,
        },
      }),
    )
  ).user;
}
async function conversation(
  first: BrowserContext,
  second: BrowserContext,
  peer: User,
) {
  const { request } = await result<{ request: { id: string } }>(
    await first.request.post('/api/v1/friends/requests', {
      headers,
      data: { user_id: peer.id },
    }),
  );
  await result(
    await second.request.post(`/api/v1/friends/requests/${request.id}/accept`, {
      headers,
      data: {},
    }),
  );
  return (
    await result<{ room: { id: string } }>(
      await first.request.post('/api/v1/rooms/direct', {
        headers,
        data: { user_id: peer.id },
      }),
    )
  ).room.id;
}
async function openConversation(page: Page, peer: string) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Messages', exact: true })
    .click();
  await page.getByRole('button', { name: peer, exact: true }).first().click();
  await expect(
    page.getByRole('textbox', { name: `Message ${peer}`, exact: true }),
  ).toBeVisible();
}
async function send(
  context: BrowserContext,
  room: string,
  body: string,
  extra: Record<string, unknown> = {},
) {
  return (
    await result<{ message: Message }>(
      await context.request.post(`/api/v1/rooms/${room}/messages`, {
        headers,
        data: { body, ...extra },
      }),
    )
  ).message;
}
async function inbox(page: Page, tab: 'Saved' | 'Reminders' = 'Reminders') {
  await page.getByRole('button', { name: /^Personal inbox/ }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Personal inbox',
    exact: true,
  });
  await dialog.getByRole('button', { name: tab, exact: true }).click();
  return dialog;
}
async function draft(context: BrowserContext, room: string, root?: string) {
  return result<{ body: string; version: number }>(
    await context.request.get(
      `/api/v1/rooms/${room}/drafts${root ? `?thread_root_id=${root}` : ''}`,
    ),
  );
}

test('saved messages and individual files stay private and reflect source edits and deletion', async ({
  browser,
}) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  let room = '';
  try {
    const suffix = `${Date.now()}`;
    await login(first, 'Comfort Saver', suffix);
    const peer = await login(second, 'Comfort Author', suffix);
    room = await conversation(first, second, peer);
    const message = await send(
      second,
      room,
      'Save this useful link https://example.test/friends',
    );
    const { attachment } = await result<{ attachment: { id: string } }>(
      await second.request.post(`/api/v1/rooms/${room}/attachments`, {
        headers,
        multipart: {
          file: {
            name: 'friends.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('A private file for friends'),
          },
        },
      }),
    );
    const fileMessage = await send(second, room, 'Save this individual file', {
      attachment_ids: [attachment.id],
    });
    const page = await first.newPage();
    await openConversation(page, peer.name);
    const item = page.locator(`[data-message-id="${message.id}"]`);
    await item.hover();
    await item
      .getByRole('button', { name: 'Save to personal inbox', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Save file friends.txt', exact: true })
      .click();
    const personal = await inbox(page, 'Saved');
    await expect(
      personal.getByRole('list', { name: 'Saved items' }),
    ).toContainText(message.body);
    await expect(
      personal.getByRole('list', { name: 'Saved items' }),
    ).toContainText('friends.txt');
    const other = await result<{ items: unknown[] }>(
      await second.request.get('/api/v1/me/saved-items'),
    );
    expect(other.items).toEqual([]);
    await result(
      await second.request.patch(
        `/api/v1/rooms/${room}/messages/${message.id}`,
        {
          headers,
          data: { body: 'Edited useful link https://example.test/updated' },
        },
      ),
    );
    await expect(
      personal.getByRole('list', { name: 'Saved items' }),
    ).toContainText('Edited useful link');
    await expect(
      personal.getByRole('list', { name: 'Saved items' }),
    ).not.toContainText('Save this useful link');
    await personal.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(
      personal.getByRole('list', { name: 'Saved items' }).getByRole('listitem'),
    ).toHaveCount(1);
    await personal
      .getByRole('button', { name: 'Open original', exact: true })
      .click();
    await expect(personal).toBeHidden();
    await expect(
      page.locator(`[data-message-id="${fileMessage.id}"]`),
    ).toBeVisible();
    await result(
      await second.request.delete(
        `/api/v1/rooms/${room}/messages/${fileMessage.id}`,
        { headers },
      ),
    );
    const reopened = await inbox(page, 'Saved');
    await reopened.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(
      reopened.getByRole('list', { name: 'Saved items' }).getByRole('listitem'),
    ).toHaveCount(0);
  } finally {
    if (room) await first.request.delete(`/api/v1/rooms/${room}`, { headers });
    await first.close();
    await second.close();
  }
});

test('automatic drafts reconcile offline conflicts across devices and clear only sent revisions', async ({
  browser,
}) => {
  const first = await browser.newContext({ baseURL });
  const device = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  let room = '';
  try {
    const suffix = `${Date.now()}`;
    await login(first, 'Comfort Drafter', suffix);
    await login(device, 'Comfort Drafter', suffix);
    const peer = await login(second, 'Comfort Draft Peer', suffix);
    room = await conversation(first, second, peer);
    const page = await first.newPage();
    const other = await device.newPage();
    await openConversation(page, peer.name);
    await openConversation(other, peer.name);
    const composer = page.getByRole('textbox', {
      name: `Message ${peer.name}`,
      exact: true,
    });
    const remoteComposer = other.getByRole('textbox', {
      name: `Message ${peer.name}`,
      exact: true,
    });
    await composer.fill('Automatic cloud draft');
    await expect
      .poll(async () => (await draft(first, room)).body)
      .toBe('Automatic cloud draft');
    await expect(remoteComposer).toHaveValue('Automatic cloud draft');
    await device.setOffline(true);
    await remoteComposer.fill('Offline device text survives');
    await composer.fill('Online text is also preserved');
    await expect
      .poll(async () => (await draft(first, room)).body)
      .toBe('Online text is also preserved');
    await device.setOffline(false);
    const conflict = other.getByRole('region', {
      name: 'Draft conflict',
      exact: true,
    });
    await expect(conflict).toContainText('Online text is also preserved');
    await expect(remoteComposer).toHaveValue('Offline device text survives');
    await conflict
      .getByRole('button', { name: 'Keep this device', exact: true })
      .click();
    await expect
      .poll(async () => (await draft(first, room)).body)
      .toBe('Offline device text survives');
    await expect(
      page.getByRole('region', { name: 'Draft conflict', exact: true }),
    ).toContainText('Offline device text survives');
    await page
      .getByRole('button', { name: 'Use other draft', exact: true })
      .click();
    await expect(composer).toHaveValue('Offline device text survives');
    const version = (await draft(first, room)).version;
    await device.setOffline(true);
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(composer).toHaveValue('');
    await expect.poll(async () => (await draft(first, room)).body).toBe('');
    expect((await draft(first, room)).version).toBeGreaterThan(version);
    await device.setOffline(false);
    await expect(remoteComposer).toHaveValue('');
    const history = await result<{ messages: Message[] }>(
      await first.request.get(`/api/v1/rooms/${room}/messages`),
    );
    expect(
      history.messages.filter(
        (message) => message.body === 'Offline device text survives',
      ),
    ).toHaveLength(1);
    await page.reload();
    await expect(
      page.getByRole('textbox', { name: `Message ${peer.name}`, exact: true }),
    ).toHaveValue('');
  } finally {
    await device.setOffline(false);
    if (room) await first.request.delete(`/api/v1/rooms/${room}`, { headers });
    await first.close();
    await device.close();
    await second.close();
  }
});

test('due reminders materialize without Web Push during quiet hours and remain explicit until done', async ({
  browser,
}) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  let room = '';
  try {
    const suffix = `${Date.now()}`;
    await login(first, 'Comfort Reminder', suffix);
    const peer = await login(second, 'Comfort Reminder Peer', suffix);
    room = await conversation(first, second, peer);
    const message = await send(second, room, 'Remember to answer this message');
    const page = await first.newPage();
    await openConversation(page, peer.name);
    const item = page.locator(`[data-message-id="${message.id}"]`);
    await item.hover();
    await item
      .getByRole('button', { name: 'Remind me to reply', exact: true })
      .click();
    const picker = page.getByRole('dialog', {
      name: 'Remind me to reply',
      exact: true,
    });
    await picker
      .getByRole('button', { name: 'In one hour', exact: true })
      .click();
    await expect(picker.getByRole('status')).toContainText(/\d/);
    await picker
      .getByRole('button', { name: 'Set reminder', exact: true })
      .click();
    await expect(picker).toBeHidden();
    const now = new Date();
    const clock = (date: Date) => date.toISOString().slice(11, 16);
    await result(
      await first.request.put('/api/v1/me/quiet-hours', {
        headers,
        data: {
          expected_version: 0,
          enabled: true,
          timezone: 'UTC',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          start_time: clock(new Date(now.getTime() - 3_600_000)),
          end_time: clock(new Date(now.getTime() + 3_600_000)),
        },
      }),
    );
    await result(
      await first.request.put(
        `/api/v1/rooms/${room}/messages/${message.id}/reminder`,
        {
          headers,
          data: {
            due_at: new Date(Date.now() + 3000).toISOString(),
            mutation_id: crypto.randomUUID(),
          },
        },
      ),
    );
    const personal = await inbox(page);
    const reminders = personal.getByRole('list', {
      name: 'Message reminders',
      exact: true,
    });
    await expect(reminders).toContainText('Due', { timeout: 25000 });
    await reminders
      .getByRole('button', { name: 'Open message', exact: true })
      .click();
    await expect(personal).toBeHidden();
    await page
      .getByRole('textbox', { name: `Message ${peer.name}`, exact: true })
      .fill('An answer does not complete a reminder');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const reopened = await inbox(page);
    await expect(
      reopened.getByRole('list', { name: 'Message reminders', exact: true }),
    ).toContainText(message.body);
    const policy = await result<{ allowed: boolean }>(
      await first.request.get(
        `/api/v1/me/notification-policy?room_id=${room}&kind=reminder`,
      ),
    );
    expect(policy.allowed).toBe(false);
    await reopened.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(
      reopened
        .getByRole('list', { name: 'Message reminders', exact: true })
        .getByRole('listitem'),
    ).toHaveCount(0);
  } finally {
    if (room) await first.request.delete(`/api/v1/rooms/${room}`, { headers });
    await first.close();
    await second.close();
  }
});

test('date and content filters find thread links without text on a 375px phone', async ({
  browser,
}) => {
  const first = await browser.newContext({
    baseURL,
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const second = await browser.newContext({ baseURL });
  let room = '';
  try {
    const suffix = `${Date.now()}`;
    await login(first, 'Comfort Mobile', suffix);
    const peer = await login(second, 'Comfort Mobile Peer', suffix);
    room = await conversation(first, second, peer);
    const root = await send(second, room, 'A root with ordinary text');
    const reply = await send(
      second,
      room,
      'A linked thread https://example.test/thread',
      { thread_root_id: root.id },
    );
    await send(second, room, '`https://example.test/code`');
    const page = await first.newPage();
    await openConversation(page, peer.name);
    await page
      .getByRole('button', { name: 'Back to messages', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Search all messages', exact: true })
      .click();
    const search = page.getByRole('dialog', {
      name: 'Search messages',
      exact: true,
    });
    await search.getByRole('button', { name: 'Today', exact: true }).click();
    await search.getByLabel('Search content type').selectOption('link');
    await expect(
      search.getByRole('searchbox', { name: 'Search messages', exact: true }),
    ).toHaveValue('');
    await search.getByRole('button', { name: 'Search', exact: true }).click();
    const results = search.getByLabel('Search results', { exact: true });
    await expect(results).toContainText('A linked thread');
    await expect(results).not.toContainText('example.test/code');
    const dimensions = await search
      .getByRole('button', { name: 'Today', exact: true })
      .boundingBox();
    expect(dimensions?.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await search.screenshot({
      path: '.local/implementation-20261011/mobile-search.png',
    });
    await results
      .getByRole('button')
      .filter({ hasText: 'A linked thread' })
      .click();
    await expect(search).toBeHidden();
    await expect(
      page.getByRole('textbox', {
        name: 'Message Thread replies',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(`[data-message-id="${reply.id}"]`)).toBeVisible();
    await page.getByRole('button', { name: /^Personal inbox/ }).click();
    const personal = page.getByRole('dialog', {
      name: 'Personal inbox',
      exact: true,
    });
    const saved = personal.getByRole('button', { name: 'Saved', exact: true });
    expect((await saved.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  } finally {
    if (room) await first.request.delete(`/api/v1/rooms/${room}`, { headers });
    await first.close();
    await second.close();
  }
});

test('temporary mute preserves its base mode and notification settings keep a running call', async ({
  browser,
}) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  let room = '';
  try {
    const suffix = `${Date.now()}`;
    const caller = await login(first, 'Comfort Call', suffix);
    const peer = await login(second, 'Comfort Call Peer', suffix);
    room = await conversation(first, second, peer);
    await result(
      await first.request.put('/api/v1/messages/notification-preferences', {
        headers,
        data: { room_id: room, mode: 'mentions' },
      }),
    );
    const page = await first.newPage();
    await openConversation(page, peer.name);
    await page
      .getByRole('button', { name: 'Conversation options', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Mute for one hour', exact: true })
      .click();
    await expect
      .poll(async () => {
        const value = await result<{ muted_until: Record<string, string> }>(
          await first.request.get('/api/v1/messages/notification-preferences'),
        );
        return Boolean(value.muted_until[room]);
      })
      .toBe(true);
    const muted = await result<{
      rooms: Record<string, string>;
      muted_until: Record<string, string>;
    }>(await first.request.get('/api/v1/messages/notification-preferences'));
    expect(muted.rooms[room]).toBe('mentions');
    expect(Date.parse(muted.muted_until[room])).toBeGreaterThan(Date.now());
    await page
      .getByRole('button', { name: 'Conversation options', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Resume timed mute', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await result<{ muted_until: Record<string, string> }>(
              await first.request.get(
                '/api/v1/messages/notification-preferences',
              ),
            )
          ).muted_until[room],
      )
      .toBeUndefined();
    const peerPage = await second.newPage();
    await openConversation(peerPage, caller.name);
    await page.getByRole('button', { name: 'Call', exact: true }).click();
    await expect(
      peerPage.getByText('Incoming call', { exact: true }),
    ).toBeVisible();
    await peerPage.getByRole('button', { name: 'Answer', exact: true }).click();
    await expect(
      peerPage.getByRole('button', { name: 'Leave call', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Leave call', exact: true }),
    ).toBeVisible();
    const settings = await openSettingsCategory(page, 'Notifications');
    await settings
      .getByRole('switch', { name: 'Do not disturb', exact: true })
      .check();
    await expect(
      settings.getByRole('switch', { name: 'Do not disturb', exact: true }),
    ).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Leave call', exact: true }),
    ).toBeVisible();
    await expect(
      peerPage.getByRole('button', { name: 'Leave call', exact: true }),
    ).toBeVisible();
    await peerPage
      .getByRole('button', { name: 'Leave call', exact: true })
      .click();
    await page.getByRole('button', { name: 'Leave call', exact: true }).click();
  } finally {
    if (room) await first.request.delete(`/api/v1/rooms/${room}`, { headers });
    await first.close();
    await second.close();
  }
});
