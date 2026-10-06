import { test, expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string };
async function value<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function login(context: BrowserContext, name: string, suffix: string) {
  return (await value<{ user: User }>(await context.request.post('/api/v1/auth/dev', { headers, data: { name, email: `${name.replaceAll(' ', '-')}-${suffix}@example.test` } }))).user;
}
async function connect(a: BrowserContext, b: BrowserContext, target: User) {
  const { request } = await value<{ request: { id: string } }>(await a.request.post('/api/v1/friends/requests', { headers, data: { user_id: target.id } }));
  await value(await b.request.post(`/api/v1/friends/requests/${request.id}/accept`, { headers, data: {} }));
  return (await value<{ room: { id: string } }>(await a.request.post('/api/v1/rooms/direct', { headers, data: { user_id: target.id } }))).room.id;
}
async function settings(page: Page, section: string) {
  await page.getByRole('button', { name: /and account options/ }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: section, exact: true }).click();
}
async function messages(page: Page, peer: string) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
  await page.getByRole('region', { name: 'Direct messages' }).getByRole('button', { name: peer, exact: true }).click();
}

test('public profile reflects editable identity and custom status across sessions', async ({ browser }) => {
  const a = await browser.newContext({ baseURL }); const b = await browser.newContext({ baseURL });
  let room = '';
  try {
    const suffix = `${Date.now()}`;
    const own = await login(a, 'Daily Author', suffix); const peer = await login(b, 'Daily Reader', suffix);
    room = await connect(a, b, peer);
    await value(await a.request.post(`/api/v1/rooms/${room}/messages`, { headers, data: { body: 'Profile entry' } }));
    const first = await a.newPage(); const second = await b.newPage();
    await first.goto('/'); await second.goto('/'); await settings(first, 'Profile');
    await first.getByLabel('Display name', { exact: true }).fill('Daily Edited');
    await first.getByLabel('Username', { exact: true }).fill(`daily_${suffix}`);
    await first.getByLabel('About you', { exact: true }).fill('An editable description');
    await first.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(first.getByText('Profile saved.', { exact: true })).toBeVisible();
    await first.getByRole('textbox', { name: 'Custom status', exact: true }).fill('Building BetterComms');
    await first.getByLabel('Clear custom status after', { exact: true }).selectOption('1h');
    await first.getByRole('button', { name: 'Save status', exact: true }).click();
    await expect.poll(async () => (await value<{ status: { text: string } }>(await a.request.get('/api/v1/me/status'))).status.text).toBe('Building BetterComms');
    await messages(second, 'Daily Edited');
    await second.getByRole('button', { name: "View Daily Edited's profile" }).first().click();
    const card = second.getByRole('dialog', { name: 'Daily Edited', exact: true });
    await expect(card).toContainText('An editable description');
    await expect(card).toContainText(`@daily_${suffix}`);
    await expect(card).toContainText('Building BetterComms');
    expect(await card.innerText()).not.toContain('@example.test');
    const publicProfile = await value<{ user: Record<string, unknown> }>(await b.request.get(`/api/v1/users/${own.id}/profile`));
    expect(publicProfile.user).not.toHaveProperty('email');
    await first.getByRole('button', { name: 'Clear status', exact: true }).click();
    await expect(card.getByText('Building BetterComms', { exact: true })).toHaveCount(0);
    await second.screenshot({ path: '.local/daily-profile.png' });
    await value(await a.request.post(`/api/v1/privacy/blocks/${peer.id}`, { headers, data: {} }));
    await expect(second.getByRole('dialog').getByText('An editable description', { exact: true })).toHaveCount(0);
    expect((await b.request.get(`/api/v1/users/${own.id}/profile`)).status()).toBe(404);
  } finally {
    if (room) await a.request.delete(`/api/v1/rooms/${room}`, { headers });
    await a.close(); await b.close();
  }
});

test('own profile opens editable settings on a phone without horizontal overflow', async ({ browser }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await login(context, 'Daily Mobile', `${Date.now()}`);
    const page = await context.newPage(); await page.goto('/');
    await page.getByRole('button', { name: /and account options/ }).click();
    await page.getByRole('menuitem', { name: 'View my profile', exact: true }).click();
    await page.getByRole('dialog', { name: 'Daily Mobile', exact: true }).getByRole('button', { name: 'Edit profile', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByLabel('Username', { exact: true }).fill(`mobile_${Date.now()}`);
    await page.getByLabel('About you', { exact: true }).fill('Edited from my phone');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: '.local/daily-mobile-profile.png' });
  } finally { await context.close(); }
});

test('favorites and archive synchronize without removing conversation membership', async ({ browser }) => {
  const a = await browser.newContext({ baseURL }); const same = await browser.newContext({ baseURL }); const b = await browser.newContext({ baseURL });
  let room = '';
  try {
    const suffix = `${Date.now()}`;
    await login(a, 'Daily Archive', suffix); await login(same, 'Daily Archive', suffix);
    const peer = await login(b, 'Daily Friend', suffix); room = await connect(a, b, peer);
    const first = await a.newPage(); const second = await same.newPage();
    await first.goto('/'); await second.goto('/'); await messages(first, peer.name); await messages(second, peer.name);
    await first.getByRole('button', { name: `Conversation actions for ${peer.name}`, exact: true }).click();
    await first.getByRole('menuitem', { name: 'Add to favorites', exact: true }).click();
    await expect.poll(async () => (await value<{ preferences: Record<string, { favorite: boolean }> }>(await same.request.get('/api/v1/me/conversations'))).preferences[room]?.favorite).toBe(true);
    await second.getByRole('button', { name: `Conversation actions for ${peer.name}`, exact: true }).click();
    await expect(second.getByRole('menuitem', { name: 'Remove from favorites', exact: true })).toBeVisible();
    await second.getByRole('menuitem', { name: 'Archive conversation', exact: true }).click();
    const list = first.getByRole('region', { name: 'Direct messages' });
    await expect(list.getByRole('button', { name: peer.name, exact: true })).toHaveCount(0);
    await first.getByRole('button', { name: /^Archived/ }).click();
    await expect(list.getByRole('button', { name: peer.name, exact: true })).toBeVisible();
    await value(await b.request.post(`/api/v1/rooms/${room}/messages`, { headers, data: { body: 'Still a member while archived' } }));
    await expect(first.getByRole('log', { name: 'Messages', exact: true })).toContainText('Still a member while archived');
    await first.getByRole('button', { name: `Conversation actions for ${peer.name}`, exact: true }).click();
    await first.getByRole('menuitem', { name: 'Restore conversation', exact: true }).click();
    await first.getByRole('button', { name: 'Active', exact: true }).click();
    await expect(list.getByRole('button', { name: peer.name, exact: true })).toBeVisible();
  } finally {
    if (room) await a.request.delete(`/api/v1/rooms/${room}`, { headers });
    await a.close(); await same.close(); await b.close();
  }
});

test('activity opens mentions and thread replies and answers pending friend requests', async ({ browser }) => {
  const a = await browser.newContext({ baseURL }); const b = await browser.newContext({ baseURL }); const pending = await browser.newContext({ baseURL });
  let room = '';
  try {
    const suffix = `${Date.now()}`;
    const own = await login(a, 'Daily Activity', suffix); const peer = await login(b, 'Daily Sender', suffix);
    const requester = await login(pending, 'Daily Request', suffix); room = await connect(a, b, peer);
    const root = (await value<{ message: { id: string } }>(await a.request.post(`/api/v1/rooms/${room}/messages`, { headers, data: { body: 'My thread root' } }))).message;
    await value(await b.request.post(`/api/v1/rooms/${room}/messages`, { headers, data: { body: 'A thread reply', thread_root_id: root.id } }));
    await value(await b.request.post(`/api/v1/rooms/${room}/messages`, { headers, data: { body: `Hello <@${own.id}> activity mention` } }));
    await value(await pending.request.post('/api/v1/friends/requests', { headers, data: { user_id: own.id } }));
    const page = await a.newPage(); await page.goto('/');
    await page.getByRole('button', { name: 'Activity', exact: true }).first().click();
    const center = page.getByRole('dialog', { name: 'Activity', exact: true });
    await expect(center.getByText('activity mention', { exact: false })).toBeVisible();
    await center.getByRole('button', { name: 'Replies', exact: true }).click();
    await expect(center.getByText('A thread reply', { exact: true })).toBeVisible();
    await center.getByRole('button', { name: `Open ${peer.name}`, exact: true }).click();
    await expect(center).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Message Thread replies', exact: true })).toBeVisible();
    await expect(page.getByText('A thread reply', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Activity', exact: true }).first().click();
    await center.getByRole('button', { name: 'Requests', exact: true }).click();
    await expect(center.getByRole('button', { name: `View ${requester.name}'s profile`, exact: true })).toBeVisible();
    await center.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(center.getByText(requester.name, { exact: true })).toHaveCount(0);
    const declined = await login(pending, 'Daily Decline', suffix);
    await value(await pending.request.post('/api/v1/friends/requests', { headers, data: { user_id: own.id } }));
    await expect(center.getByRole('button', { name: `View ${declined.name}'s profile`, exact: true })).toBeVisible();
    await center.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(center.getByRole('button', { name: `View ${declined.name}'s profile`, exact: true })).toHaveCount(0);
    await page.screenshot({ path: '.local/daily-activity.png' });
  } finally {
    if (room) await a.request.delete(`/api/v1/rooms/${room}`, { headers });
    await a.close(); await b.close(); await pending.close();
  }
});

test('portable preferences require opt-in and keep local shortcuts untouched', async ({ browser }) => {
  const a = await browser.newContext({ baseURL }); const b = await browser.newContext({ baseURL });
  try {
    const suffix = `${Date.now()}`; await login(a, 'Daily Sync', suffix); await login(b, 'Daily Sync', suffix);
    const first = await a.newPage(); const second = await b.newPage(); await first.goto('/'); await second.goto('/');
    await second.evaluate(() => localStorage.setItem('bc-ptt-key', 'ControlRight'));
    await settings(first, 'Appearance'); await settings(second, 'Appearance');
    await first.getByRole('switch', { name: 'Sync preferences', exact: true }).check();
    await expect(first.getByText('Preferences are up to date.', { exact: true })).toBeVisible();
    await first.getByRole('button', { name: 'Toggle theme', exact: true }).click();
    await first.getByRole('menuitem', { name: 'Light', exact: true }).click();
    await expect.poll(async () => (await value<{ settings: { theme?: string } }>(await a.request.get('/api/v1/me/preferences'))).settings.theme).toBe('light');
    await expect(second.locator('html')).toHaveClass(/dark/);
    await second.getByRole('switch', { name: 'Sync preferences', exact: true }).check();
    await expect(second.locator('html')).toHaveClass(/light/);
    await first.getByRole('combobox', { name: 'Camera placement' }).click();
    await first.getByRole('option', { name: 'On the right', exact: true }).click();
    await expect(second.getByRole('combobox', { name: 'Camera placement' })).toContainText('On the right');
    expect(await second.evaluate(() => localStorage.getItem('bc-ptt-key'))).toBe('ControlRight');
  } finally { await a.close(); await b.close(); }
});

test('Chromium voice recording uploads and plays privately and emoji recents retain tone', async ({ browser }) => {
  const a = await browser.newContext({ baseURL }); const b = await browser.newContext({ baseURL }); let room = '';
  try {
    const suffix = `${Date.now()}`; await login(a, 'Daily Voice', suffix); const peer = await login(b, 'Daily Listener', suffix); room = await connect(a, b, peer);
    const first = await a.newPage(); const second = await b.newPage(); await first.goto('/'); await second.goto('/');
    await messages(first, peer.name); await messages(second, 'Daily Voice');
    await first.getByRole('button', { name: 'Record voice note', exact: true }).click();
    await first.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(first.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
    await expect(first.getByText('0:01 / 2:00', { exact: true })).toBeVisible();
    await first.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect(first.getByLabel('Preview your voice note', { exact: true })).toBeVisible();
    await first.getByRole('button', { name: 'Attach voice note', exact: true }).click();
    await first.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(second.getByRole('button', { name: 'Listen to voice note', exact: true })).toBeVisible();
    const history = await value<{ messages: { attachments?: { voice_note: boolean; duration_ms: number }[] }[] }>(await b.request.get(`/api/v1/rooms/${room}/messages`));
    expect(history.messages[0].attachments?.[0]).toMatchObject({ voice_note: true });
    expect(history.messages[0].attachments?.[0].duration_ms).toBeGreaterThanOrEqual(800);
    await second.getByRole('button', { name: 'Listen to voice note', exact: true }).click();
    const audio = second.getByLabel('Play voice note', { exact: true });
    await expect(audio).toBeVisible();
    await audio.evaluate((element: HTMLAudioElement) => {
      void element.play().catch((error: DOMException) => { element.dataset.playbackError = error.name; });
    });
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => ({
      playing: element.currentTime > 0, ready: element.readyState,
      network: element.networkState, hasSource: element.hasAttribute('src'),
      mediaError: element.error?.code ?? 0, rejected: element.dataset.playbackError ?? '',
    }))).toMatchObject({ playing: true, ready: 4, network: 1, hasSource: true, mediaError: 0, rejected: '' });
    await first.getByRole('button', { name: 'Insert emoji', exact: true }).click();
    const picker = first.getByRole('dialog', { name: 'Choose emoji', exact: true });
    await picker.getByLabel('Emoji skin tone', { exact: true }).selectOption('🏽');
    await picker.getByRole('searchbox', { name: 'Search emojis', exact: true }).fill('thumbs up medium skin tone');
    await picker.getByRole('searchbox').press('ArrowDown');
    await first.keyboard.press('Enter');
    await expect(first.getByRole('textbox', { name: `Message ${peer.name}`, exact: true })).toHaveValue('👍🏽');
    await first.getByRole('button', { name: 'Insert emoji', exact: true }).click();
    await expect(picker.getByRole('button', { name: 'Recent emoji thumbs up: medium skin tone', exact: true })).toBeVisible();
    await expect(picker.getByLabel('Emoji skin tone', { exact: true })).toHaveValue('🏽');
    await first.screenshot({ path: '.local/daily-voice-emojis.png' });
  } finally {
    if (room) await a.request.delete(`/api/v1/rooms/${room}`, { headers });
    await a.close(); await b.close();
  }
});
