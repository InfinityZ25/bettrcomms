import { test, expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string; username?: string; bio?: string; avatar_url?: string };
type Room = { id: string; name: string; kind: string; owner_id: string };
async function value<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function login(context: BrowserContext, name: string, suffix: string) {
  return (await value<{ user: User }>(await context.request.post('/api/v1/auth/dev', { headers, data: { name, email: `${name}-${suffix}@example.test` } }))).user;
}
async function friends(a: BrowserContext, b: BrowserContext, target: User) {
  const { request } = await value<{ request: { id: string } }>(await a.request.post('/api/v1/friends/requests', { headers, data: { user_id: target.id } }));
  await value(await b.request.post(`/api/v1/friends/requests/${request.id}/accept`, { headers, data: {} }));
}
async function section(page: Page, name: 'Messages' | 'Rooms') {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name, exact: true }).click();
}
async function profile(page: Page) {
  await page.getByRole('button', { name: /and account options/ }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Profile', exact: true }).click();
}

test('profile and account presence persist and synchronize across two sessions', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  const [first, second, contact] = contexts;
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const own = await login(first, 'social-profile', suffix);
    await login(second, 'social-profile', suffix);
    const friend = await login(contact, 'social-contact', suffix);
    await friends(first, contact, friend);
    const a = await first.newPage(); const b = await second.newPage(); const c = await contact.newPage();
    await a.goto('/'); await b.goto('/'); await c.goto('/');
    await profile(a); await profile(b);
    const username = 'social_' + suffix.replaceAll('-', '_');
    await a.getByLabel('Display name', { exact: true }).fill('Social edited');
    await a.getByLabel('Username', { exact: true }).fill(username.slice(0, 32));
    await a.getByLabel('About you', { exact: true }).fill('Across both devices');
    await a.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(a.getByText('Profile saved.', { exact: true })).toBeVisible();
    await expect(b.getByText('Your profile was updated.', { exact: false })).toBeVisible();
    await b.getByRole('button', { name: 'Load the current profile' }).click();
    await expect(b.getByLabel('Display name', { exact: true })).toHaveValue('Social edited');
    await expect(b.getByLabel('About you', { exact: true })).toHaveValue('Across both devices');
    await a.getByRole('combobox', { name: 'Account status' }).click();
    await a.getByRole('option', { name: 'Invisible', exact: true }).click();
    await expect(b.getByRole('combobox', { name: 'Account status' })).toContainText('Invisible');
    await c.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Friends', exact: true }).click();
    // The contact sees effective status, never the other account's desired "invisible" state.
    await expect(c.getByRole('dialog').getByText('Offline', { exact: true }).first()).toBeVisible();
    expect(await contact.request.get(`/api/v1/users/${own.id}/avatar`).then((response) => response.status())).toBe(404);
    const png = await a.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      const context = canvas.getContext('2d')!; context.fillStyle = '#55aa88'; context.fillRect(0, 0, 16, 16);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await a.getByLabel('Choose profile photo', { exact: true }).setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(a.getByText('Profile photo updated.', { exact: true })).toBeVisible();
    await expect(b.locator('img[src^="blob:"]').first()).toBeVisible();
    const avatar = await contact.request.get(`/api/v1/users/${own.id}/avatar`);
    expect(avatar.status()).toBe(200); expect(avatar.headers()['content-type']).toBe('image/png');
    await a.getByRole('button', { name: 'Remove photo', exact: true }).click();
    await expect(a.getByText('Profile photo removed.', { exact: true })).toBeVisible();
    expect((await contact.request.get(`/api/v1/users/${own.id}/avatar`)).status()).toBe(404);
    await a.getByRole('combobox', { name: 'Account status' }).click();
    await a.getByRole('option', { name: 'Do not disturb', exact: true }).click();
    await expect(b.getByRole('combobox', { name: 'Account status' })).toContainText('Do not disturb');
    await expect(c.getByRole('dialog').getByText('Do not disturb', { exact: true }).first()).toBeVisible();
    await a.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close', exact: true }).click();
    // A fresh dev login must preserve edited fields and saved availability.
    const again = await login(first, 'social-profile', suffix);
    expect(again.name).toBe('Social edited');
    expect(again.bio).toBe('Across both devices');
    const presence = await value<{ status: string }>(await first.request.get('/api/v1/me/presence'));
    expect(presence.status).toBe('dnd');
  } finally { for (const context of contexts) await context.close(); }
});

test('group creation, messages, membership and owner transfer work through the UI', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  const [owner, guest, added] = contexts;
  let roomId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(owner, 'social-owner', suffix);
    const guestUser = await login(guest, 'social-guest', suffix);
    const addedUser = await login(added, 'social-added', suffix);
    await friends(owner, guest, guestUser); await friends(owner, added, addedUser);
    const a = await owner.newPage(); const b = await guest.newPage();
    await a.goto('/'); await b.goto('/'); await section(a, 'Messages');
    await a.getByRole('button', { name: 'New group message', exact: true }).click();
    const dialog = a.getByRole('dialog', { name: 'New group message', exact: true });
    await dialog.getByLabel('Group name', { exact: true }).fill('Social group');
    await dialog.getByRole('checkbox', { name: 'social-guest', exact: true }).check();
    await dialog.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(a.getByRole('textbox', { name: 'Message Social group', exact: true })).toBeVisible();
    const list = await value<{ rooms: Room[] }>(await owner.request.get('/api/v1/rooms'));
    const room = list.rooms.find((item) => item.kind === 'group'); expect(room).toBeTruthy(); roomId = room!.id;
    await a.getByRole('textbox', { name: 'Message Social group', exact: true }).fill('Group hello');
    await a.getByRole('button', { name: 'Send message', exact: true }).click();
    await section(b, 'Messages'); await b.getByRole('button', { name: 'Social group', exact: true }).click();
    await expect(b.getByText('Group hello', { exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Group info', exact: true }).click();
    await a.getByRole('button', { name: 'Add social-added to group', exact: true }).click();
    await expect(a.getByRole('dialog', { name: 'Group info' }).getByText('Members · 3/10')).toBeVisible();
    await expect.poll(async () => (await added.request.get(`/api/v1/rooms/${roomId}/messages`)).status()).toBe(200);
    // Profile events must refresh people without discarding an in-progress group-name draft.
    await a.getByRole('dialog', { name: 'Group info' }).getByLabel('Group name', { exact: true }).fill('Unsaved group draft');
    await value(await guest.request.patch('/api/v1/me', { headers, data: { name: 'Social guest updated' } }));
    await expect(a.getByRole('dialog', { name: 'Group info' }).getByRole('strong').filter({ hasText: 'Social guest updated' })).toBeVisible();
    await expect(a.getByRole('dialog', { name: 'Group info' }).getByLabel('Group name', { exact: true })).toHaveValue('Unsaved group draft');
    await a.getByRole('dialog', { name: 'Group info' }).getByRole('button', { name: 'Close', exact: true }).click();
    await a.getByRole('button', { name: 'Call', exact: true }).click();
    await expect(b.getByText('Incoming call', { exact: true })).toBeVisible();
    await b.getByRole('button', { name: 'Answer', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
    await expect(b.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
    await b.getByRole('button', { name: 'Leave call', exact: true }).click();
    await a.getByRole('button', { name: 'Leave call', exact: true }).click();
    await a.getByRole('button', { name: 'Group info', exact: true }).click();
    await a.getByRole('dialog', { name: 'Group info' }).getByRole('button', { name: 'Leave group', exact: true }).click();
    await a.getByRole('button', { name: 'Confirm leave', exact: true }).click();
    await expect(a.getByRole('dialog', { name: 'Group info' })).toBeHidden();
    await expect.poll(async () => (await owner.request.get(`/api/v1/rooms/${roomId}`)).status()).toBe(403);
    await expect.poll(async () => (await value<{ rooms: Room[] }>(await guest.request.get('/api/v1/rooms'))).rooms.find((item) => item.id === roomId)?.owner_id).toBe(guestUser.id);
    await b.getByRole('button', { name: 'Group info', exact: true }).click();
    await expect(b.getByRole('dialog', { name: 'Group info' }).getByRole('button', { name: 'Add social-owner to group', exact: true })).toBeVisible();
  } finally {
    if (roomId) await guest.request.delete(`/api/v1/rooms/${roomId}`, { headers });
    for (const context of contexts) await context.close();
  }
});

test('shareable invitation requires authentication and acceptance, then can be revoked', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  const [owner, guest, anonymous] = contexts;
  let roomId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(owner, 'social-inviter', suffix); await login(guest, 'social-invited', suffix);
    const { room } = await value<{ room: Room }>(await owner.request.post('/api/v1/rooms', { headers, data: { name: 'Invitation room' } })); roomId = room.id;
    const a = await owner.newPage(); await a.goto('/'); await section(a, 'Rooms');
    await a.getByRole('button', { name: 'Invitation room', exact: true }).click({ button: 'right' });
    await a.getByRole('menuitem', { name: 'Room settings…', exact: true }).click();
    await a.getByRole('button', { name: 'Create invitation link', exact: true }).click();
    const link = await a.getByLabel('New invitation link', { exact: true }).inputValue();
    expect(new URL(link).hash).toContain('invite=');
    const b = await guest.newPage();
    await b.goto(new URL(link).pathname + new URL(link).hash);
    await expect(b.getByRole('dialog', { name: 'Room invitation', exact: true })).toBeVisible();
    await expect(b.getByRole('dialog').getByText('Invitation room', { exact: true })).toBeVisible();
    expect((await guest.request.get(`/api/v1/rooms/${roomId}`)).status()).toBe(403);
    await b.getByRole('button', { name: 'Join room', exact: true }).click();
    await expect(b.getByRole('dialog', { name: 'Room invitation', exact: true })).toBeHidden();
    expect((await guest.request.get(`/api/v1/rooms/${roomId}/messages`)).status()).toBe(200);
    const unauth = await anonymous.newPage(); await unauth.goto(new URL(link).pathname + new URL(link).hash);
    await expect(unauth.getByText('Sign in to review your room invitation.', { exact: false })).toBeVisible();
    await expect(unauth.getByRole('button', { name: 'Continue with WorkOS', exact: false })).toBeVisible();
    await expect(unauth.getByRole('dialog', { name: 'Room invitation', exact: true })).toBeHidden();
    await a.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(a.getByText('Revoked', { exact: true })).toBeVisible();
    await b.goto(new URL(link).pathname + new URL(link).hash);
    await expect(b.getByRole('dialog').getByRole('alert')).toBeVisible();
    await expect(b.getByRole('button', { name: 'Join room', exact: true })).toBeDisabled();
  } finally {
    if (roomId) await owner.request.delete(`/api/v1/rooms/${roomId}`, { headers });
    for (const context of contexts) await context.close();
  }
});
