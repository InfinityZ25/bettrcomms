import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string };

async function value<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext, name: string, suffix: string) {
  return (
    await value<{ user: User }>(
      await context.request.post('/api/v1/auth/dev', {
        headers,
        data: {
          name,
          email: `${name.replaceAll(' ', '-').toLowerCase()}-${suffix}@example.test`,
        },
      }),
    )
  ).user;
}

async function openConversation(page: Page, peer: User) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Messages', exact: true })
    .click();
  await page
    .getByRole('region', { name: 'Direct messages' })
    .getByRole('button', { name: peer.name, exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: `Message ${peer.name}`, exact: true }),
  ).toBeVisible();
}

test('revealed spoilers survive real conversation updates and hide again only on request or content edits', async ({
  browser,
}) => {
  const authorContext = await browser.newContext({ baseURL });
  const readerContext = await browser.newContext({ baseURL });
  let roomId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const author = await login(authorContext, 'Spoiler Author', suffix);
    const reader = await login(readerContext, 'Spoiler Reader', suffix);
    const { request } = await value<{ request: { id: string } }>(
      await authorContext.request.post('/api/v1/friends/requests', {
        headers,
        data: { user_id: reader.id },
      }),
    );
    await value(
      await readerContext.request.post(
        `/api/v1/friends/requests/${request.id}/accept`,
        { headers, data: {} },
      ),
    );
    roomId = (
      await value<{ room: { id: string } }>(
        await authorContext.request.post('/api/v1/rooms/direct', {
          headers,
          data: { user_id: reader.id },
        }),
      )
    ).room.id;
    const { message } = await value<{ message: { id: string } }>(
      await authorContext.request.post(`/api/v1/rooms/${roomId}/messages`, {
        headers,
        data: { body: 'Ending: ||**secret ending**||.' },
      }),
    );
    const authorPage = await authorContext.newPage();
    const readerPage = await readerContext.newPage();
    await openConversation(authorPage, reader);
    await openConversation(readerPage, author);
    const row = readerPage.locator(`[data-message-id="${message.id}"]`);
    const secret = row.getByText('secret ending', { exact: true });
    await expect(secret).toHaveCount(0);
    await row
      .getByRole('button', { name: 'Reveal spoiler', exact: true })
      .click();
    await expect(secret).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Hide spoiler', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true');

    // A real reaction event replaces the message object and rerenders its body.
    await value(
      await authorContext.request.put(
        `/api/v1/rooms/${roomId}/messages/${message.id}/reactions`,
        { headers, data: { emoji: '👍' } },
      ),
    );
    await expect(
      row.getByRole('button', { name: 'React 👍, 1', exact: true }),
    ).toBeVisible();
    await expect(secret).toBeVisible();

    const composer = authorPage.getByRole('textbox', {
      name: `Message ${reader.name}`,
      exact: true,
    });
    await composer.fill('A new message while the ending is revealed');
    await expect(
      readerPage.getByText(`${author.name} is typing…`),
    ).toBeVisible();
    await expect(secret).toBeVisible();
    await authorPage
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      readerPage.getByRole('log', { name: 'Messages', exact: true }),
    ).toContainText('A new message while the ending is revealed');
    await expect(
      readerPage.getByText(`${author.name} is typing…`),
    ).toBeHidden();
    await expect(secret).toBeVisible();

    await row
      .getByRole('button', { name: 'Hide spoiler', exact: true })
      .click();
    await expect(secret).toHaveCount(0);
    await row
      .getByRole('button', { name: 'Reveal spoiler', exact: true })
      .press('Enter');
    await expect(secret).toBeVisible();
    await row
      .getByRole('button', { name: 'Hide spoiler', exact: true })
      .press('Enter');
    await expect(secret).toHaveCount(0);
    await row
      .getByRole('button', { name: 'Reveal spoiler', exact: true })
      .press('Enter');
    await expect(secret).toBeVisible();

    // Revealing an earlier revision must not expose a newly edited spoiler.
    await value(
      await authorContext.request.patch(
        `/api/v1/rooms/${roomId}/messages/${message.id}`,
        {
          headers,
          data: { body: 'Updated ending: ||**different secret**||.' },
        },
      ),
    );
    await expect(row).toContainText('Updated ending:');
    await expect(secret).toHaveCount(0);
    await expect(
      row.getByText('different secret', { exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: 'Reveal spoiler', exact: true }),
    ).toHaveAttribute('aria-expanded', 'false');
  } finally {
    if (roomId)
      await authorContext.request.delete(`/api/v1/rooms/${roomId}`, {
        headers,
      });
    await authorContext.close();
    await readerContext.close();
  }
});
