import { expect, test, type APIResponse } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
async function value<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

test('safe formatting, spoilers and Unicode emoji work in real conversations', async ({ browser }) => {
  const owner = await browser.newContext({ baseURL });
  const peer = await browser.newContext({ baseURL });
  let roomId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await value(await owner.request.post('/api/v1/auth/dev', { headers, data: { name: 'Format Owner', email: `format-owner-${suffix}@example.test` } }));
    const friend = (await value<{ user: { id: string } }>(await peer.request.post('/api/v1/auth/dev', { headers, data: { name: 'Format Peer', email: `format-peer-${suffix}@example.test` } }))).user;
    const request = (await value<{ request: { id: string } }>(await owner.request.post('/api/v1/friends/requests', { headers, data: { user_id: friend.id } }))).request;
    await value(await peer.request.post(`/api/v1/friends/requests/${request.id}/accept`, { headers, data: {} }));
    roomId = (await value<{ room: { id: string } }>(await owner.request.post('/api/v1/rooms/direct', { headers, data: { user_id: friend.id } }))).room.id;
    const first = (await value<{ message: { id: string } }>(await owner.request.post(`/api/v1/rooms/${roomId}/messages`, { headers, data: { body: '**Formatted heading** *italic text* ||hidden ending||\n\n> a quotation\n\n```js\n<script>unsafe()</script>\n```\n\n![external](https://example.test/tracker.png)' } }))).message;
    const page = await owner.newPage();
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
    await page.getByRole('region', { name: 'Direct messages' }).getByRole('button', { name: 'Format Peer', exact: true }).click();
    const row = page.locator(`[data-message-id="${first.id}"]`);
    await expect(row.locator('strong').filter({ hasText: 'Formatted heading' })).toBeVisible();
    await expect(row.locator('em')).toHaveText('italic text');
    await expect(row.locator('blockquote')).toContainText('a quotation');
    await expect(row.locator('pre')).toContainText('<script>unsafe()</script>');
    await expect(row.locator('img[src="https://example.test/tracker.png"]')).toHaveCount(0);
    await expect(row.getByText('hidden ending', { exact: true })).toHaveCount(0);
    await row.getByRole('button', { name: 'Reveal spoiler', exact: true }).click();
    await expect(row.getByText('hidden ending', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Hide spoiler', exact: true }).click();
    await expect(row.getByText('hidden ending', { exact: true })).toHaveCount(0);

    const input = page.getByRole('textbox', { name: 'Message Format Peer', exact: true });
    await input.fill('hello ');
    await page.getByRole('button', { name: 'Insert emoji', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose emoji', exact: true });
    await picker.getByRole('searchbox', { name: 'Search emojis', exact: true }).fill('woman technologist');
    await picker.getByRole('button', { name: 'Emoji woman technologist', exact: true }).click();
    await expect(input).toHaveValue('hello 👩‍💻');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('log', { name: 'Messages', exact: true })).toContainText('hello 👩‍💻');
    await row.hover();
    await row.getByRole('button', { name: 'Add reaction', exact: true }).click();
    await picker.getByRole('searchbox', { name: 'Search emojis', exact: true }).fill('thumbs up medium skin tone');
    await picker.getByRole('button', { name: 'Emoji thumbs up: medium skin tone', exact: true }).click();
    await expect(row.getByRole('button', { name: 'React 👍🏽, 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const saved = await value<{ message: { reactions: { emoji: string }[] } }>(await peer.request.get(`/api/v1/rooms/${roomId}/messages/${first.id}`));
    expect(saved.message.reactions.some((reaction) => reaction.emoji === '👍🏽')).toBe(true);
  } finally {
    if (roomId) await owner.request.delete(`/api/v1/rooms/${roomId}`, { headers });
    await owner.close(); await peer.close();
  }
});
