import { expect, test, type APIResponse, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { openSettingsCategory } from './settings-navigation';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string; avatar_url?: string | null; character: { variant: number; hue: number | null } };
type Room = { id: string };
type Message = { id: string; body: string };

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext, name: string, email: string) {
  const deadline = Date.now() + 65_000;
  for (;;) {
    const response = await context.request.post('/api/v1/auth/dev', { headers, data: { name, email } });
    if (response.status() !== 429 || Date.now() >= deadline) {
      const result = await json<User | { user: User }>(response);
      return 'user' in result ? result.user : result;
    }
    await response.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function conversation(owner: BrowserContext, peer: BrowserContext, peerUser: User) {
  const request = await json<{ request: { id: string } }>(await owner.request.post('/api/v1/friends/requests', { headers, data: { user_id: peerUser.id } }));
  await json(await peer.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, { headers, data: {} }));
  const { room } = await json<{ room: Room }>(await owner.request.post('/api/v1/rooms/direct', { headers, data: { user_id: peerUser.id } }));
  const { message } = await json<{ message: Message }>(await owner.request.post(`/api/v1/rooms/${room.id}/messages`, { headers, data: { body: 'A shared place for our characters' } }));
  return { room, message };
}

async function openConversation(page: Page, other: User) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Messages', exact: true }).click();
  const conversations = (page.viewportSize()?.width ?? 1280) <= 820
    ? page.getByRole('list', { name: 'Direct messages', exact: true })
    : page.getByRole('region', { name: 'Direct messages', exact: true });
  await conversations.getByRole('button', { name: other.name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: `Message ${other.name}`, exact: true })).toBeVisible();
}

const characterFor = (container: Page | Locator, user: User) => container.locator(`.companion[data-companion-user="${user.id}"]`);
/** Your own character lives on screen as the companion; the composer's gesture button shows a hand beside it. */
const screenCompanion = (page: Page, user: User) => page.locator(`.pet:not(.pet-visitor)[data-companion-user="${user.id}"]`);
const activity = (container: Page | Locator) => container.locator('[aria-label="Live conversation activity"]');

async function gesture(page: Page, kind: 'Wave' | 'Nod' | 'Celebrate', container: Page | Locator = page) {
  const trigger = container.getByRole('button', { name: 'Character gestures', exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await page.getByRole('menuitem', { name: kind, exact: true }).click();
}

async function callControl(page: Page, name: string) {
  await page.locator('.call-workspace').hover({ position: { x: 10, y: 10 } });
  await page.getByRole('button', { name, exact: true }).click();
}

async function photoBytes(page: Page) {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 24;
    const graphics = canvas.getContext('2d')!;
    graphics.fillStyle = '#4f9175'; graphics.fillRect(0, 0, 24, 24);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(encoded, 'base64');
}

async function messages(context: BrowserContext, roomId: string) {
  const result = await json<{ messages: Message[] }>(await context.request.get(`/api/v1/rooms/${roomId}/messages`));
  return result.messages.map(({ id, body }) => ({ id, body }));
}

async function activeCharacterAnimations(page: Page) {
  return page.locator('.companion').evaluateAll((nodes) => nodes.reduce((count, node) => count +
    node.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running' || animation.pending).length, 0));
}

async function closeOwnedRoom(owner: BrowserContext, roomId: string) {
  if (roomId) await Promise.allSettled([owner.request.delete(`/api/v1/rooms/${roomId}`, { headers, timeout: 5000 })]);
}

test('a saved personal character synchronizes across devices and friends while retaining photos and ephemeral gestures', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await browser.newContext({ baseURL });
  const mirror = await browser.newContext({ baseURL });
  const peer = await browser.newContext({ baseURL });
  let roomId = '';
  try {
    await peer.addInitScript(observeCallCompanions);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const email = `companion-owner-${suffix}@example.test`;
    const me = await login(owner, 'Companion Ada', email);
    expect((await login(mirror, me.name, email)).id).toBe(me.id);
    const friend = await login(peer, 'Companion Grace', `companion-friend-${suffix}@example.test`);
    const shared = await conversation(owner, peer, friend);
    roomId = shared.room.id;
    const editorPage = await owner.newPage();
    const mirrorPage = await mirror.newPage();
    const peerPage = await peer.newPage();
    await editorPage.goto('/');
    await openConversation(mirrorPage, friend);
    await openConversation(peerPage, me);
    const settings = await openSettingsCategory(editorPage, 'Profile');
    await settings.getByLabel('Choose profile photo', { exact: true }).setInputFiles({
      name: 'character-owner.png', mimeType: 'image/png', buffer: await photoBytes(editorPage),
    });
    await expect(settings.getByText('Profile photo updated.', { exact: true })).toBeVisible();
    const originalPhoto = (await json<{ user: User }>(await owner.request.get('/api/v1/me'))).user.avatar_url;
    expect(originalPhoto).toBeTruthy();

    const character = settings.getByRole('region', { name: 'Your character', exact: true });
    await character.getByRole('button', { name: 'Character 3', exact: true }).click();
    await character.getByRole('button', { name: 'Sky', exact: true }).click();
    await character.getByRole('button', { name: 'Save character', exact: true }).click();
    await expect(character.getByText('Character saved.', { exact: true })).toBeVisible();
    const saved = (await json<{ user: User }>(await owner.request.get('/api/v1/me'))).user;
    expect(saved.character).toEqual({ variant: 2, hue: 210 });
    expect(saved.avatar_url).toBe(originalPhoto);
    const mirrorCharacter = screenCompanion(mirrorPage, me);
    await expect(mirrorCharacter).toHaveAttribute('data-character-hue', '210');
    const seed = await mirrorCharacter.getAttribute('data-character-seed');
    expect(seed).toBeTruthy();

    // The friend's typing figure must use the account's current saved appearance.
    await mirrorPage.getByRole('textbox', { name: `Message ${friend.name}`, exact: true }).fill('A draft, not a new durable message');
    await expect(activity(peerPage)).toContainText(`${me.name} is typing…`);
    await expect(characterFor(activity(peerPage), me)).toHaveAttribute('data-character-seed', seed!);
    await expect(characterFor(activity(peerPage), me)).toHaveAttribute('data-character-hue', '210');
    await mirrorPage.getByRole('textbox', { name: `Message ${friend.name}`, exact: true }).fill('');
    const peerPhoto = peerPage.locator(`[data-message-id="${shared.message.id}"] img[alt="${me.name}"][src^="blob:"]`);
    await expect(peerPhoto).toBeVisible();
    expect((await peer.request.get(`/api/v1/users/${me.id}/avatar`)).status()).toBe(200);

    const beforeGesture = await messages(owner, roomId);
    await gesture(mirrorPage, 'Wave');
    await expect(activity(peerPage)).toContainText(`${me.name} waves`);
    await expect.poll(() => peerPage.evaluate((id) =>
      (window as Window & { __companionCompleted?: string[] }).__companionCompleted?.includes(id) ?? false, me.id)).toBe(true);
    await expect(characterFor(activity(peerPage), me)).toHaveAttribute('data-character-seed', seed!);
    await expect(peerPage.getByRole('log', { name: 'Messages', exact: true })).not.toContainText(`${me.name} waves`);
    expect(await messages(owner, roomId)).toEqual(beforeGesture);

    await editorPage.reload();
    const reloaded = await openSettingsCategory(editorPage, 'Profile');
    await expect(reloaded.getByRole('button', { name: 'Character 3', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(reloaded.getByRole('button', { name: 'Sky', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect((await json<{ user: User }>(await owner.request.get('/api/v1/me'))).user.avatar_url).toBe(originalPhoto);
  } finally {
    await closeOwnedRoom(owner, roomId);
    await Promise.allSettled([owner.close(), mirror.close(), peer.close()]);
  }
});

test('thread characters stay in their scope and quiet or reduced motion keeps gestures still on a narrow screen', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const owner = await browser.newContext({ baseURL });
  const peer = await browser.newContext({ baseURL });
  let roomId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const me = await login(owner, 'Character Thread Ada', `character-thread-owner-${suffix}@example.test`);
    const friend = await login(peer, 'Character Thread Grace', `character-thread-peer-${suffix}@example.test`);
    const shared = await conversation(owner, peer, friend);
    roomId = shared.room.id;
    const ownerPage = await owner.newPage();
    const peerPage = await peer.newPage();
    await openConversation(ownerPage, friend);
    await openConversation(peerPage, me);
    for (const page of [ownerPage, peerPage]) {
      const root = page.locator(`[data-message-id="${shared.message.id}"]`);
      await root.hover();
      await root.getByRole('button', { name: 'Open thread', exact: true }).click();
    }
    const ownerThread = ownerPage.getByRole('complementary', { name: 'Message thread', exact: true });
    const peerThread = peerPage.getByRole('complementary', { name: 'Message thread', exact: true });
    const threadDraft = ownerThread.getByRole('textbox', { name: 'Message Thread replies', exact: true });
    await threadDraft.fill('An unsent reply in this thread only');
    await expect(activity(peerThread)).toContainText(`${me.name} is typing…`);
    await expect(characterFor(activity(peerThread), me)).toHaveCount(1);
    const mainActivity = peerPage.locator('.message-thread[aria-label="Conversation messages"] > [aria-label="Live conversation activity"]');
    await expect(characterFor(mainActivity, me)).toHaveCount(0);
    await threadDraft.fill('');
    await peerPage.emulateMedia({ reducedMotion: 'reduce' });
    await gesture(ownerPage, 'Wave', ownerThread);
    await expect(activity(peerThread)).toContainText(`${me.name} waves`);
    await expect(characterFor(mainActivity, me)).toHaveCount(0);
    expect(await activeCharacterAnimations(peerPage)).toBe(0);
    await expect(peerPage.locator('html')).toHaveAttribute('data-companion-motion', 'quiet');
    await expect(ownerThread.getByRole('button', { name: 'Character gestures', exact: true })).toBeEnabled();
    await ownerThread.getByRole('button', { name: 'Close thread', exact: true }).click();
    await peerThread.getByRole('button', { name: 'Close thread', exact: true }).click();

    // A device's quiet choice also survives a reload without hiding the gesture text.
    await peerPage.emulateMedia({ reducedMotion: 'no-preference' });
    const appearance = await openSettingsCategory(peerPage, 'Appearance');
    const motion = appearance.getByRole('switch', { name: 'Character motion', exact: true });
    await motion.uncheck();
    await appearance.getByRole('button', { name: 'Close', exact: true }).click();
    await peerPage.setViewportSize({ width: 390, height: 844 });
    await openConversation(peerPage, me);
    await expect(peerPage.locator('html')).toHaveAttribute('data-companion-motion', 'quiet');
    await gesture(ownerPage, 'Nod');
    await expect(activity(peerPage)).toContainText(`${me.name} nods`);
    expect(await activeCharacterAnimations(peerPage)).toBe(0);
    expect(await peerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const gestureBox = await peerPage.getByRole('button', { name: 'Character gestures', exact: true }).boundingBox();
    const sendBox = await peerPage.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
    expect(gestureBox).not.toBeNull(); expect(sendBox).not.toBeNull();
    expect(gestureBox!.x).toBeGreaterThanOrEqual(0);
    expect(gestureBox!.x + gestureBox!.width).toBeLessThanOrEqual(391);
    const overlaps = gestureBox!.x < sendBox!.x + sendBox!.width && gestureBox!.x + gestureBox!.width > sendBox!.x &&
      gestureBox!.y < sendBox!.y + sendBox!.height && gestureBox!.y + gestureBox!.height > sendBox!.y;
    expect(overlaps).toBe(false);
    await peerPage.screenshot({ path: testInfo.outputPath('personal-companions-mobile-quiet.png'), fullPage: true });
  } finally {
    await closeOwnedRoom(owner, roomId);
    await Promise.allSettled([owner.close(), peer.close()]);
  }
});

// Observe real browser animations and room sockets without replacing media or application state.
function observeCallCompanions() {
  const current = window as Window & { __companionRoomSockets?: WebSocket[]; __companionAnimations?: string[]; __companionCompleted?: string[] };
  current.__companionRoomSockets = [];
  current.__companionAnimations = [];
  current.__companionCompleted = [];
  const NativeSocket = window.WebSocket;
  class ObservedSocket extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (String(url).includes('/ws?')) current.__companionRoomSockets!.push(this);
    }
  }
  window.WebSocket = ObservedSocket as typeof WebSocket;
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
    const animation = animate.apply(this, args);
    if (this.matches('.companion')) {
      const userId = (this as HTMLElement).dataset.companionUser ?? '';
      current.__companionAnimations!.push(userId);
      void animation.finished.then(() => current.__companionCompleted!.push(userId), () => {});
    }
    return animation;
  };
}

test('calls keep the account character through resume and rejoin with a separate photo footer beside live video', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const owner = await browser.newContext({ baseURL });
  const peer = await browser.newContext({ baseURL });
  let roomId = '';
  try {
    await owner.addInitScript(observeCallCompanions);
    await peer.addInitScript(observeCallCompanions);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const me = await login(owner, 'Call Character Ada', `character-call-owner-${suffix}@example.test`);
    const friend = await login(peer, 'Call Character Grace', `character-call-peer-${suffix}@example.test`);
    await json(await owner.request.patch('/api/v1/me/character', { headers, data: { variant: 3, hue: 150 } }));
    const shared = await conversation(owner, peer, friend);
    roomId = shared.room.id;
    const ownerPage = await owner.newPage();
    const peerPage = await peer.newPage();
    await openConversation(ownerPage, friend);
    await openConversation(peerPage, me);
    const ownCharacter = screenCompanion(ownerPage, me);
    await expect(ownCharacter).toHaveAttribute('data-character-hue', '150');
    const originalSeed = await ownCharacter.getAttribute('data-character-seed');
    const uploaded = await owner.request.post('/api/v1/me/avatar', { headers, multipart: {
      file: { name: 'call-character-photo.png', mimeType: 'image/png', buffer: await photoBytes(ownerPage) },
    } });
    await json(uploaded);
    await expect(peerPage.locator(`[data-message-id="${shared.message.id}"] img[alt="${me.name}"][src^="blob:"]`)).toBeVisible();
    await ownerPage.getByRole('region', { name: `Conversation with ${friend.name}`, exact: true }).getByRole('button', { name: 'Call', exact: true }).click();
    await expect(ownerPage.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
    await peerPage.getByRole('region', { name: `Conversation with ${me.name}`, exact: true }).getByRole('button', { name: 'Call', exact: true }).click();
    await expect(peerPage.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
    const remoteTile = peerPage.locator(`.camera-participant-tile:not(.self)[data-user-id="${me.id}"]`);
    await expect(remoteTile).toBeVisible();
    await expect(characterFor(remoteTile.locator('.camera-tile-media'), me)).toHaveAttribute('data-character-seed', originalSeed!);
    await expect(characterFor(remoteTile.locator('.camera-tile-media'), me)).toHaveAttribute('data-character-hue', '150');
    await expect(remoteTile.locator('.participant-identity img[alt="' + me.name + '"]')).toBeVisible();
    // Synthetic audio may keep changing the finite speaking transition.
    // Arrival movement belongs to the wrapper and must finish independently.
    await expect.poll(() => peerPage.locator('.companion').evaluateAll((nodes) =>
      nodes.reduce((count, node) => count + node.getAnimations().length, 0))).toBe(0);
    expect(await peerPage.locator('.companion').evaluateAll((nodes) => nodes.some((node) =>
      node.getAnimations({ subtree: true }).some((animation) => animation.effect?.getTiming().iterations === Infinity)))).toBe(false);
    const arrivalsBefore = await peerPage.evaluate(() => (window as Window & { __companionAnimations?: string[] }).__companionAnimations!.length);

    // A signaling resume delivers another peer snapshot, never a new social arrival.
    await peerPage.evaluate(() => {
      const sockets = (window as Window & { __companionRoomSockets?: WebSocket[] }).__companionRoomSockets!;
      const socket = sockets.at(-1)!;
      socket.onclose?.(new CloseEvent('close', { code: 1006, wasClean: false }));
    });
    await expect(peerPage.getByText('Reconnecting to server', { exact: false })).toBeVisible();
    await expect(peerPage.getByText('Reconnecting to server', { exact: false })).toHaveCount(0, { timeout: 30_000 });
    await expect(characterFor(remoteTile.locator('.camera-tile-media'), me)).toHaveAttribute('data-character-seed', originalSeed!);
    expect(await peerPage.evaluate(() => (window as Window & { __companionAnimations?: string[] }).__companionAnimations!.length)).toBe(arrivalsBefore);

    await callControl(ownerPage, 'Leave call');
    await expect(remoteTile).toHaveCount(0);
    await ownerPage.getByRole('region', { name: `Conversation with ${friend.name}`, exact: true }).getByRole('button', { name: 'Call', exact: true }).click();
    await expect(ownerPage.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
    await expect(characterFor(remoteTile.locator('.camera-tile-media'), me)).toHaveAttribute('data-character-seed', originalSeed!);
    await expect.poll(() => peerPage.evaluate((id) =>
      (window as Window & { __companionCompleted?: string[] }).__companionCompleted?.includes(id) ?? false, me.id)).toBe(true);
    await callControl(ownerPage, 'Turn on camera');
    const video = remoteTile.locator('video');
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
    await expect(remoteTile.locator('.participant-name')).toHaveText(me.name);
    await expect(remoteTile.locator('.participant-identity img[alt="' + me.name + '"]')).toBeVisible();
    await expect(remoteTile.locator(`.tile-camera-companion[data-companion-user="${me.id}"]`)).toHaveAttribute('data-character-seed', originalSeed!);
    const bounds = await remoteTile.evaluate((node) => {
      const media = node.querySelector('video')!.getBoundingClientRect();
      const footer = node.querySelector('.participant-caption')!.getBoundingClientRect();
      const companion = node.querySelector('.tile-camera-companion')!.getBoundingClientRect();
      return { videoBottom: media.bottom, footerTop: footer.top, footerBottom: footer.bottom, companionTop: companion.top, companionBottom: companion.bottom };
    });
    expect(bounds.videoBottom).toBeLessThanOrEqual(bounds.footerTop + 1);
    expect(bounds.companionTop).toBeGreaterThanOrEqual(bounds.footerTop - 1);
    expect(bounds.companionBottom).toBeLessThanOrEqual(bounds.footerBottom + 1);
    await peerPage.setViewportSize({ width: 390, height: 844 });
    const backToCall = peerPage.getByRole('button', { name: 'Back to call', exact: true });
    if (await backToCall.isVisible()) await backToCall.click();
    await expect(remoteTile).toBeVisible();
    expect(await peerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await peerPage.screenshot({ path: testInfo.outputPath('personal-companions-call-mobile.png'), fullPage: true });
  } finally {
    await closeOwnedRoom(owner, roomId);
    await Promise.allSettled([owner.close(), peer.close()]);
  }
});
