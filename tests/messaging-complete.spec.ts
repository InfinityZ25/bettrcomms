import { expect, test, type APIResponse } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

test('typing, draft recovery and conversation notification choices work across two users', async ({ browser }) => {
  const ownerContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  let directId = '';
  let otherId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const owner = (await json<{ user: { id: string } }>(await ownerContext.request.post('/api/v1/auth/dev', { headers, data: { name: 'Draft Owner', email: `draft-owner-${suffix}@example.test` } }))).user;
    const guest = (await json<{ user: { id: string } }>(await guestContext.request.post('/api/v1/auth/dev', { headers, data: { name: 'Draft Guest', email: `draft-guest-${suffix}@example.test` } }))).user;
    const request = await json<{ request: { id: string } }>(await ownerContext.request.post('/api/v1/friends/requests', { headers, data: { user_id: guest.id } }));
    await json(await guestContext.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, { headers, data: {} }));
    directId = (await json<{ room: { id: string } }>(await ownerContext.request.post('/api/v1/rooms/direct', { headers, data: { user_id: guest.id } }))).room.id;
    otherId = (await json<{ room: { id: string } }>(await ownerContext.request.post('/api/v1/rooms', { headers, data: { name: 'Draft side room' } }))).room.id;

    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();
    await ownerPage.goto('/');
    await guestPage.goto('/');
    await ownerPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
    await guestPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
    await ownerPage.getByRole('region', { name: 'Direct messages' }).getByRole('button', { name: 'Draft Guest' }).click();
    const ownerComposer = ownerPage.getByRole('textbox', { name: 'Message Draft Guest' });
    await expect(ownerComposer).toBeVisible();
    await expect(guestPage.getByRole('textbox', { name: 'Message Draft Owner' })).toBeVisible();
    await ownerComposer.fill('A draft that should survive navigation');
    await expect(guestPage.getByText('Draft Owner is typing…')).toBeVisible();

    const directButton = ownerPage.getByRole('region', { name: 'Direct messages' }).getByRole('button', { name: 'Draft Guest' });
    await directButton.click({ button: 'right' });
    await ownerPage.getByRole('menuitem', { name: 'Mentions only' }).click();
    const preferences = await json<{ rooms: Record<string, string> }>(await ownerContext.request.get('/api/v1/messages/notification-preferences'));
    expect(preferences.rooms[directId]).toBe('mentions');

    await ownerPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Calls', exact: true }).click();
    await ownerPage.getByRole('button', { name: 'Draft side room', exact: true }).click();
    await ownerPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
    await directButton.click();
    await expect(ownerPage.getByRole('textbox', { name: 'Message Draft Guest' })).toHaveValue('A draft that should survive navigation');
    await ownerPage.reload();
    await ownerPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
    await ownerPage.getByRole('region', { name: 'Direct messages' }).getByRole('button', { name: 'Draft Guest' }).click();
    await expect(ownerPage.getByRole('textbox', { name: 'Message Draft Guest' })).toHaveValue('A draft that should survive navigation');
    await ownerPage.close();
    const reopenedPage = await ownerContext.newPage();
    await reopenedPage.goto('/');
    await reopenedPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
    await reopenedPage.getByRole('region', { name: 'Direct messages' }).getByRole('button', { name: 'Draft Guest' }).click();
    await expect(reopenedPage.getByRole('textbox', { name: 'Message Draft Guest' })).toHaveValue('A draft that should survive navigation');
  } finally {
    if (otherId) await ownerContext.request.delete(`/api/v1/rooms/${otherId}`, { headers });
    await Promise.all([ownerContext.close(), guestContext.close()]);
  }
});
