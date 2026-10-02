import { expect, test, type APIResponse } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

test('pins and independent threads synchronize, preserve drafts and open search results in their scope', async ({ browser }) => {
  const ownerContext = await browser.newContext({ baseURL });
  const peerContext = await browser.newContext({ baseURL });
  let roomId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const owner = (await json<{ user: { id: string } }>(await ownerContext.request.post('/api/v1/auth/dev', { headers, data: { name: 'Thread Owner', email: `thread-owner-${suffix}@example.test` } }))).user;
    const peer = (await json<{ user: { id: string } }>(await peerContext.request.post('/api/v1/auth/dev', { headers, data: { name: 'Thread Peer', email: `thread-peer-${suffix}@example.test` } }))).user;
    const request = await json<{ request: { id: string } }>(await ownerContext.request.post('/api/v1/friends/requests', { headers, data: { user_id: peer.id } }));
    await json(await peerContext.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, { headers, data: {} }));
    roomId = (await json<{ room: { id: string } }>(await ownerContext.request.post('/api/v1/rooms/direct', { headers, data: { user_id: peer.id } }))).room.id;
    const root = (await json<{ message: { id: string } }>(await ownerContext.request.post(`/api/v1/rooms/${roomId}/messages`, { headers, data: { body: 'Original project discussion' } }))).message;
    const ownerPage = await ownerContext.newPage();
    const peerPage = await peerContext.newPage();
    await ownerPage.goto('/'); await peerPage.goto('/');
    await ownerPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
    await peerPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
    await ownerPage.getByRole('region', { name: 'Direct messages' }).getByRole('button', { name: 'Thread Peer' }).click();
    await peerPage.getByRole('region', { name: 'Direct messages' }).getByRole('button', { name: 'Thread Owner' }).click();
    const original = ownerPage.locator(`[data-message-id="${root.id}"]`);
    await original.hover(); await original.getByRole('button', { name: 'Pin message', exact: true }).click();
    await expect(peerPage.locator(`[data-message-id="${root.id}"]`).getByText('Pinned', { exact: true })).toBeVisible();
    await peerPage.getByRole('button', { name: 'Pinned messages', exact: true }).click();
    await expect(peerPage.getByRole('region', { name: 'Pinned messages' })).toContainText('Original project discussion');
    await peerPage.getByRole('region', { name: 'Pinned messages' }).getByRole('button').click();

    const mainDraft = ownerPage.getByRole('textbox', { name: 'Message Thread Peer', exact: true });
    await mainDraft.fill('Main draft stays separate');
    await original.getByRole('button', { name: 'Open thread', exact: true }).click();
    const ownerThread = ownerPage.getByRole('complementary', { name: 'Message thread' });
    await ownerThread.getByRole('textbox', { name: 'Message Thread replies', exact: true }).fill('Independent thread searchable needle');
    await ownerThread.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(ownerThread.getByRole('log', { name: 'Thread replies' })).toContainText('Independent thread searchable needle');
    await expect(ownerPage.getByRole('log', { name: 'Messages', exact: true })).not.toContainText('Independent thread searchable needle');
    await peerPage.locator(`[data-message-id="${root.id}"]`).getByRole('button', { name: 'Open thread', exact: true }).click();
    const peerThread = peerPage.getByRole('complementary', { name: 'Message thread' });
    await expect(peerThread.getByRole('log', { name: 'Thread replies' })).toContainText('Independent thread searchable needle');
    await ownerThread.getByRole('textbox', { name: 'Message Thread replies', exact: true }).fill('Unsent thread draft');
    await expect(peerThread.getByText('Thread Owner is typing…', { exact: true })).toBeVisible();
    await expect(peerPage.getByRole('log', { name: 'Messages', exact: true })).not.toContainText('Thread Owner is typing…');
    await ownerThread.getByRole('button', { name: 'Close thread', exact: true }).click();
    await expect(mainDraft).toHaveValue('Main draft stays separate');
    await original.getByRole('button', { name: 'Open thread', exact: true }).click();
    await expect(ownerPage.getByRole('textbox', { name: 'Message Thread replies', exact: true })).toHaveValue('Unsent thread draft');
    await ownerPage.getByRole('button', { name: 'Close thread', exact: true }).click();

    await ownerPage.getByRole('button', { name: 'Search this conversation', exact: true }).click();
    const search = ownerPage.getByRole('dialog');
    await search.getByRole('searchbox', { name: 'Search messages', exact: true }).fill('searchable needle');
    await search.getByRole('button', { name: 'Search', exact: true }).click();
    await search.getByText('Independent thread searchable needle', { exact: true }).click();
    await expect(ownerPage.getByRole('complementary', { name: 'Message thread' }).getByRole('log', { name: 'Thread replies' })).toContainText('Independent thread searchable needle');
    await ownerPage.getByRole('button', { name: 'Close thread', exact: true }).click();

    const currentRoot = ownerPage.locator(`[data-message-id="${root.id}"]`);
    await currentRoot.hover(); await currentRoot.getByRole('button', { name: 'Delete message', exact: true }).click();
    await currentRoot.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await expect(currentRoot).toContainText('Message deleted');
    await currentRoot.getByRole('button', { name: 'Open thread', exact: true }).click();
    await expect(ownerPage.getByRole('log', { name: 'Thread replies' })).toContainText('Independent thread searchable needle');
    const pins = await json<{ messages: unknown[] }>(await ownerContext.request.get(`/api/v1/rooms/${roomId}/pins`));
    expect(pins.messages).toEqual([]);
    expect(owner.id).toBeTruthy();
  } finally {
    if (roomId) await ownerContext.request.delete(`/api/v1/rooms/${roomId}`, { headers });
    await ownerContext.close(); await peerContext.close();
  }
});
