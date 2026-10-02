import { expect, test, type APIResponse } from '@playwright/test';
import { openSettingsCategory } from './settings-navigation';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
async function value<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

test('channel controls synchronize posting restrictions, slow mode and bans', async ({ browser }) => {
  const owner = await browser.newContext({ baseURL });
  const peer = await browser.newContext({ baseURL });
  let roomId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await value(await owner.request.post('/api/v1/auth/dev', { headers, data: { name: 'Moderation Owner', email: `moderation-owner-${suffix}@example.test` } }));
    const user = (await value<{ user: { id: string } }>(await peer.request.post('/api/v1/auth/dev', { headers, data: { name: 'Moderation Peer', email: `moderation-peer-${suffix}@example.test` } }))).user;
    const request = (await value<{ request: { id: string } }>(await owner.request.post('/api/v1/friends/requests', { headers, data: { user_id: user.id } }))).request;
    await value(await peer.request.post(`/api/v1/friends/requests/${request.id}/accept`, { headers, data: {} }));
    roomId = (await value<{ room: { id: string } }>(await owner.request.post('/api/v1/rooms', { headers, data: { name: 'Moderation acceptance' } }))).room.id;
    await value(await owner.request.post(`/api/v1/rooms/${roomId}/members`, { headers, data: { user_id: user.id } }));
    const ownerPage = await owner.newPage();
    const peerPage = await peer.newPage();
    await ownerPage.goto('/'); await peerPage.goto('/');
    await ownerPage.getByRole('button', { name: 'Moderation acceptance', exact: true }).click({ button: 'right' });
    await ownerPage.getByRole('menuitem', { name: 'Room settings…', exact: true }).click();
    const controls = ownerPage.getByRole('region', { name: 'Channel moderation' });
    await controls.getByRole('combobox', { name: 'Member to moderate' }).selectOption(user.id);
    await controls.getByRole('textbox', { name: 'Reason (3–500 characters)' }).fill('Acceptance test posting restriction');
    await peerPage.getByRole('button', { name: 'Moderation acceptance', exact: true }).click();
    await peerPage.getByRole('button', { name: 'Toggle room messages' }).click();
    const draft = peerPage.getByRole('textbox', { name: 'Message Moderation acceptance', exact: true });
    await draft.fill('Preserve this draft');
    await controls.getByRole('button', { name: 'Restrict posting', exact: true }).click();
    await expect(peerPage.getByText('Posting is temporarily restricted in this channel.', { exact: true })).toBeVisible();
    await expect(peerPage.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await expect(draft).toHaveValue('Preserve this draft');
    const restricted = await peer.request.post(`/api/v1/rooms/${roomId}/messages`, { headers, data: { body: 'Forbidden bypass' } });
    expect(restricted.status()).toBe(403);
    await controls.getByRole('button', { name: 'Remove restriction', exact: true }).click();
    await expect(peerPage.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await controls.getByRole('spinbutton', { name: 'Slow mode (seconds, 0 disables)' }).fill('60');
    await controls.getByRole('button', { name: 'Save slow mode', exact: true }).click();
    await peerPage.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(peerPage.getByRole('log', { name: 'Messages', exact: true })).toContainText('Preserve this draft');
    await expect(peerPage.getByText('Slow mode: wait before sending another message.', { exact: true })).toBeVisible();
    const slow = await peer.request.post(`/api/v1/rooms/${roomId}/messages`, { headers, data: { body: 'Cooldown bypass' } });
    expect(slow.status()).toBe(429);
    await controls.getByRole('combobox', { name: 'Moderation action' }).selectOption('ban');
    await controls.getByRole('button', { name: 'Ban member…', exact: true }).click();
    await controls.getByRole('button', { name: 'Confirm ban', exact: true }).click();
    await expect(peerPage.getByRole('button', { name: 'Moderation acceptance', exact: true })).toHaveCount(0);
    expect((await peer.request.get(`/api/v1/rooms/${roomId}/messages`)).status()).toBe(403);
    await controls.getByRole('button', { name: 'Unban', exact: true }).click();
    await value(await owner.request.post(`/api/v1/rooms/${roomId}/members`, { headers, data: { user_id: user.id } }));
    await expect(peerPage.getByRole('button', { name: 'Moderation acceptance', exact: true })).toBeVisible();
  } finally {
    if (roomId) await owner.request.delete(`/api/v1/rooms/${roomId}`, { headers });
    await owner.close(); await peer.close();
  }
});

test('account settings revoke other live sessions and confirm account deletion', async ({ browser }) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  try {
    const email = `session-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    for (const context of [first, second]) await value(await context.request.post('/api/v1/auth/dev', { headers, data: { name: 'Session Acceptance', email } }));
    const firstPage = await first.newPage();
    const secondPage = await second.newPage();
    await firstPage.goto('/'); await secondPage.goto('/');
    const settings = await openSettingsCategory(firstPage, 'Account');
    await expect(settings.getByRole('button', { name: 'Revoke session', exact: true })).toHaveCount(1);
    await settings.getByRole('button', { name: 'Sign out other devices', exact: true }).click();
    await expect(settings.getByRole('button', { name: 'Revoke session', exact: true })).toHaveCount(0);
    await expect(secondPage.getByRole('button', { name: 'Continue with WorkOS', exact: true })).toBeVisible();
    expect((await second.request.get('/api/v1/me')).status()).toBe(401);
    expect((await first.request.get('/api/v1/me')).status()).toBe(200);
    await settings.getByRole('button', { name: 'Delete account…', exact: true }).click();
    await settings.getByRole('textbox', { name: 'Your account email' }).fill(email);
    await settings.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE');
    await settings.getByRole('button', { name: 'Permanently delete account', exact: true }).click();
    await expect(firstPage.getByRole('button', { name: 'Continue with WorkOS', exact: true })).toBeVisible();
    expect((await first.request.get('/api/v1/me')).status()).toBe(401);
  } finally {
    await first.close(); await second.close();
  }
});
