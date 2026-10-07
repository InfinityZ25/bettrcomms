import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string };
type Room = { id: string; name: string; community_id: string; channel_type: 'hybrid' | 'announcement' };
type Community = { id: string; name: string; channels: Room[] };

async function value<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function login(context: BrowserContext, name: string, suffix: string) {
  return (await value<{ user: User }>(await context.request.post('/api/v1/auth/dev', {
    headers, data: { name, email: `${name.toLowerCase().replaceAll(' ', '-')}-${suffix}@example.test` },
  }))).user;
}

test('room roles govern shared hybrid channels, announcements and live revocation', async ({ browser }) => {
  test.setTimeout(180_000);
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext({ baseURL })));
  const [owner, admin, moderator, member] = contexts;
  let communityId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const users = await Promise.all(contexts.map((context, index) => login(context, ['Room Owner', 'Room Admin', 'Room Moderator', 'Room Member'][index], suffix)));
    for (let index = 1; index < contexts.length; index++) {
      const { request } = await value<{ request: { id: string } }>(await owner.request.post('/api/v1/friends/requests', { headers, data: { user_id: users[index].id } }));
      await value(await contexts[index].request.post(`/api/v1/friends/requests/${request.id}/accept`, { headers, data: {} }));
    }
    const { community } = await value<{ community: Community }>(await owner.request.post('/api/v1/communities', {
      headers, data: { name: `Weekend friends ${suffix}`, description: 'Text and voice together' },
    }));
    communityId = community.id;
    for (const user of users.slice(1)) await value(await owner.request.post(`/api/v1/communities/${communityId}/members`, { headers, data: { user_id: user.id } }));
    const { room: games } = await value<{ room: Room }>(await owner.request.post(`/api/v1/communities/${communityId}/channels`, {
      headers, data: { name: 'games', topic: 'Chat while playing', channel_type: 'hybrid' },
    }));
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const [ownerPage, adminPage, moderatorPage, memberPage] = pages;
    await Promise.all(pages.map((page) => page.goto('/')));
    await ownerPage.getByRole('button', { name: `${community.name} room settings`, exact: true }).click();
    const settings = ownerPage.getByRole('dialog', { name: community.name, exact: true });
    await settings.getByRole('button', { name: /^Members(?: ·|$)/ }).click();
    await settings.getByRole('combobox', { name: `Role for ${users[1].name}`, exact: true }).selectOption('admin');
    await expect(adminPage.getByRole('button', { name: `Create channel in ${community.name}`, exact: true })).toBeVisible();
    await settings.getByRole('combobox', { name: `Role for ${users[2].name}`, exact: true }).selectOption('moderator');
    await settings.getByRole('button', { name: /^Channels(?: ·|$)/ }).click();
    await settings.getByRole('button', { name: 'New channel', exact: true }).click();
    const channelDialog = ownerPage.getByRole('dialog', { name: 'Create a channel', exact: true });
    await channelDialog.getByRole('textbox', { name: 'Channel name', exact: true }).fill('updates');
    await channelDialog.getByRole('radio', { name: /Announcements/ }).check();
    await channelDialog.getByRole('button', { name: 'Create channel', exact: true }).click();
    await expect(channelDialog).toBeHidden();
    await ownerPage.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    const latest = (await value<{ community: Community }>(await owner.request.get(`/api/v1/communities/${communityId}`))).community;
    const announcements = latest.channels.find((channel) => channel.name === 'updates')!;
    expect(announcements.channel_type).toBe('announcement');
    const shared = (await value<{ rooms: Room[] }>(await member.request.get('/api/v1/rooms'))).rooms.filter((room) => room.community_id === communityId);
    expect(shared.map((room) => room.id).sort()).toEqual(latest.channels.map((room) => room.id).sort());

    for (const page of pages) {
      await page.getByRole('button', { name: 'updates', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Message updates', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Join voice', exact: true })).toHaveCount(0);
    }
    for (const page of [moderatorPage, memberPage]) {
      await page.getByRole('textbox', { name: 'Message updates', exact: true }).fill('Keep this local draft');
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Record voice note', exact: true })).toBeDisabled();
    }
    const published = `Owner update ${suffix}`;
    await ownerPage.getByRole('textbox', { name: 'Message updates', exact: true }).fill(published);
    await ownerPage.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(memberPage.getByRole('log', { name: 'Messages', exact: true })).toContainText(published);
    await expect(memberPage.getByRole('textbox', { name: 'Message updates', exact: true })).toHaveValue('Keep this local draft');
    await adminPage.getByRole('textbox', { name: 'Message updates', exact: true }).fill(`Admin update ${suffix}`);
    await adminPage.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(memberPage.getByRole('log', { name: 'Messages', exact: true })).toContainText(`Admin update ${suffix}`);
    expect((await moderator.request.post(`/api/v1/rooms/${announcements.id}/messages`, { headers, data: { body: 'Moderator bypass' } })).status()).toBe(403);
    expect((await member.request.post(`/api/v1/rooms/${announcements.id}/messages`, { headers, data: { body: 'Member bypass' } })).status()).toBe(403);
    expect((await moderator.request.post(`/api/v1/communities/${communityId}/channels`, { headers, data: { name: 'forbidden' } })).status()).toBe(403);
    expect((await admin.request.put(`/api/v1/communities/${communityId}/members/${users[2].id}/role`, { headers, data: { role: 'admin' } })).status()).toBe(403);

    await memberPage.getByRole('button', { name: 'games', exact: true }).click();
    await expect(memberPage.getByRole('textbox', { name: 'Message games', exact: true })).toBeVisible();
    await expect(memberPage.getByRole('button', { name: 'Leave call', exact: true })).toHaveCount(0);
    await memberPage.getByRole('button', { name: 'Join voice', exact: true }).click();
    await expect(memberPage.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
    await value(await owner.request.patch(`/api/v1/communities/${communityId}/channels/${games.id}`, { headers, data: { channel_type: 'announcement' } }));
    await expect(memberPage.getByRole('button', { name: 'Leave call', exact: true })).toHaveCount(0);
    await expect(memberPage.getByRole('button', { name: 'Join voice', exact: true })).toHaveCount(0);
    expect((await member.request.get(`/api/v1/rooms/${games.id}/ws`)).status()).toBe(403);

    await value(await moderator.request.put(`/api/v1/rooms/${announcements.id}/moderation/bans/${users[3].id}`, { headers, data: { reason: 'Shared room revocation acceptance' } }));
    await expect(memberPage.getByRole('button', { name: `${community.name} room settings`, exact: true })).toHaveCount(0);
    for (const channel of latest.channels) expect((await member.request.get(`/api/v1/rooms/${channel.id}/messages`)).status()).toBe(403);
    const remaining = (await value<{ rooms: Room[] }>(await member.request.get('/api/v1/rooms'))).rooms;
    expect(remaining.some((room) => room.community_id === communityId)).toBe(false);
  } finally {
    if (communityId) await owner.request.delete(`/api/v1/communities/${communityId}`, { headers });
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});
