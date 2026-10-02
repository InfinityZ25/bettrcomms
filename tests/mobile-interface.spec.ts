import AxeBuilder from '@axe-core/playwright';
import { openMobileFriends, swipe } from './mobile-touch';
import { expect, test, type BrowserContext } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
// A translated ancestor can give getBoundingClientRect() a few millionths of
// a pixel of subtraction error even when the button's CSS size is 44px.
const layoutPixels = (value: number) => Math.round(value * 1_000) / 1_000;
const headers = { Origin: new URL(baseURL).origin };
async function post(context: BrowserContext, path: string, data: unknown) {
  const deadline = Date.now() + 65_000;
  for (;;) {
    const response = await context.request.post('/api/v1' + path, {
      headers,
      data,
    });
    if (response.status() === 429 && Date.now() < deadline) {
      await response.dispose();
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    expect(
      response.ok(),
      `API ${response.status()}: ${await response.text()}`,
    ).toBeTruthy();
    return response.json();
  }
}

test('mobile conversation menu opens pins and threads without adding a header or losing drafts', async ({ browser }) => {
  const phone = await browser.newContext({ baseURL, viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });
  const friend = await browser.newContext({ baseURL });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await post(phone, '/auth/dev', { name: 'Panel Writer', email: `panel-writer-${suffix}@example.test` });
    const { user: other } = await post(friend, '/auth/dev', { name: 'Panel Friend', email: `panel-friend-${suffix}@example.test` });
    const { request } = await post(phone, '/friends/requests', { user_id: other.id });
    await post(friend, `/friends/requests/${request.id}/accept`, {});
    const { room } = await post(phone, '/rooms/direct', { user_id: other.id });
    const { message: root } = await post(phone, `/rooms/${room.id}/messages`, { body: 'Pinned discussion for the mobile menu' });
    await post(friend, `/rooms/${room.id}/messages`, { body: 'Independent mobile reply', thread_root_id: root.id });
    const pinned = await phone.request.put(`/api/v1/rooms/${room.id}/messages/${root.id}/pin`, { headers });
    expect(pinned.ok(), await pinned.text()).toBeTruthy();
    const page = await phone.newPage();
    await page.goto('/');
    const conversation = page.getByRole('region', { name: 'Conversation with Panel Friend', exact: true });
    await expect(conversation).toBeVisible();
    const composer = conversation.getByRole('textbox', { name: 'Message Panel Friend', exact: true });
    await composer.fill('Keep this main draft while browsing');
    const menu = conversation.getByRole('button', { name: 'Conversation options', exact: true });
    const toolbar = conversation.locator('.thread-tools');
    const pins = conversation.getByRole('region', { name: 'Pinned messages', exact: true });
    const threads = conversation.getByRole('region', { name: 'Conversation threads', exact: true });
    await expect(toolbar).toBeHidden();
    await expect(conversation.locator('.conversation-header')).toHaveCount(1);
    await menu.tap();
    await page.getByRole('menuitem', { name: 'Pinned messages', exact: true }).click();
    await expect(pins).toBeVisible();
    await expect(pins).toContainText('Pinned discussion for the mobile menu');
    await expect(toolbar).toBeHidden();
    await expect(composer).toHaveValue('Keep this main draft while browsing');
    await pins.getByRole('button', { name: 'Close pinned messages', exact: true }).tap();
    await expect(pins).toBeHidden();
    await menu.tap();
    await page.getByRole('menuitem', { name: 'Conversation threads', exact: true }).click();
    await expect(threads).toBeVisible();
    await expect(threads).toContainText('1 replies');
    await expect(toolbar).toBeHidden();
    await threads.getByRole('button', { name: 'Close conversation threads', exact: true }).tap();
    await expect(threads).toBeHidden();
    await expect(composer).toHaveValue('Keep this main draft while browsing');

    await menu.tap();
    await page.getByRole('menuitem', { name: 'Conversation threads', exact: true }).click();
    await threads.getByRole('button', { name: /Pinned discussion for the mobile menu/ }).tap();
    const thread = conversation.getByRole('complementary', { name: 'Message thread', exact: true });
    await expect(thread).toBeVisible();
    const threadComposer = thread.getByRole('textbox', { name: 'Message Thread replies', exact: true });
    await threadComposer.fill('Keep this independent thread draft');
    await menu.tap();
    await page.getByRole('menuitem', { name: 'Pinned messages', exact: true }).click();
    await expect(thread).toBeHidden();
    await expect(pins).toBeVisible();
    await expect(composer).toHaveValue('Keep this main draft while browsing');
    await pins.getByRole('button', { name: 'Close pinned messages', exact: true }).tap();
    await menu.tap();
    await page.getByRole('menuitem', { name: 'Conversation threads', exact: true }).click();
    await threads.getByRole('button', { name: /Pinned discussion for the mobile menu/ }).tap();
    await expect(threadComposer).toHaveValue('Keep this independent thread draft');
  } finally {
    await phone.close();
    await friend.close();
  }
});

test('mobile conversation navigation, actions and keyboard preserve usable screen space', async ({
  browser,
}) => {
  const phone = await browser.newContext({
    baseURL,
    viewport: { width: 402, height: 874 },
    hasTouch: true,
    isMobile: true,
  });
  const friend = await browser.newContext({ baseURL });
  try {
    const suffix = Date.now();
    await post(phone, '/auth/dev', {
      name: 'Mobile Writer',
      email: `writer-${suffix}@example.test`,
    });
    const result = await post(friend, '/auth/dev', {
      name: 'Phone Friend',
      email: `friend-${suffix}@example.test`,
    });
    const other = result.user ?? result;
    const request = await post(phone, '/friends/requests', {
      user_id: other.id,
    });
    await post(friend, `/friends/requests/${request.request.id}/accept`, {});
    const { room } = await post(phone, '/rooms/direct', { user_id: other.id });
    for (let i = 0; i < 14; i++)
      await post(phone, `/rooms/${room.id}/messages`, {
        body: `Message ${i}: a conversation that can scroll without moving the application.`,
        client_nonce: crypto.randomUUID(),
      });
    const page = await phone.newPage();
    await page.goto('/');
    const cdp =
      browser.browserType().name() === 'chromium'
        ? await phone.newCDPSession(page)
        : null;
    if (cdp)
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 59, bottom: 34 },
      });
    const safeTop = cdp ? 59 : 0;
    const conversation = page.getByRole('region', {
      name: 'Conversation with Phone Friend',
      exact: true,
    });
    await expect(conversation).toBeVisible();
    const header = conversation.locator('.conversation-header');
    const composer = conversation.getByRole('textbox');
    await expect(composer).toBeVisible();
    // One header, readable text, and no nested border around the input.
    await expect(conversation.locator('.thread-tools')).toBeHidden();
    expect(
      await composer.evaluate((node) =>
        parseFloat(getComputedStyle(node).fontSize),
      ),
    ).toBeGreaterThanOrEqual(16);
    await expect(composer).toHaveAttribute('placeholder', 'Message…');
    expect(
      (
        await new AxeBuilder({ page })
          .include('.conversation-header')
          .include('.message-thread')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await expect(
      page.getByRole('button', { name: 'Messages', exact: true }),
    ).toHaveAttribute('aria-current', 'page');

    const last = conversation.locator('article').last();
    await expect(last).toBeInViewport();
    const before = (await last.boundingBox())!;
    await last.getByText(/Message 13:/).tap();
    expect((await last.boundingBox())!.height).toBeCloseTo(before.height, 0);
    await last
      .getByRole('button', { name: 'Message options for Mobile Writer' })
      .click();
    await expect(
      page.getByRole('menuitem', { name: 'Reply', exact: true }),
    ).toBeVisible();
    await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
    await expect(
      conversation.getByText(/Replying to Mobile Writer/),
    ).toBeVisible();
    await conversation
      .getByRole('button', { name: 'Cancel reply or edit' })
      .click();

    // Emulate WebKit's keyboard shrinking and panning its visual viewport.
    // This verifies layout; the real OS keyboard still needs a phone check.
    await composer.fill('Keep this draft when I go back');
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, 'height', {
        configurable: true,
        get: () => 450,
      });
      Object.defineProperty(viewport, 'offsetTop', {
        configurable: true,
        get: () => 80,
      });
      viewport.dispatchEvent(new Event('resize'));
    });
    await expect(
      page.getByRole('navigation', { name: 'Sections' }),
    ).toBeHidden();
    await expect
      .poll(async () =>
        Math.round(
          (await page.locator('[data-app-shell]').boundingBox())!.height,
        ),
      )
      .toBe(450);
    const headerBox = (await header.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    expect(headerBox.y).toBeGreaterThanOrEqual(80);
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(530);
    await expect(last).toBeInViewport();
    await page.screenshot({
      path: '.local/mobile-ui-review/keyboard-after.png',
    });

    await composer.blur();
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      // iOS can briefly keep a stale offset after dismissing the keyboard.
      Object.defineProperty(viewport, 'height', {
        configurable: true,
        get: () => window.innerHeight,
      });
      viewport.dispatchEvent(new Event('resize'));
    });
    await expect(
      page.getByRole('navigation', { name: 'Sections' }),
    ).toBeVisible();
    await expect
      .poll(async () => Math.round((await header.boundingBox())!.y))
      .toBe(safeTop);

    await page
      .getByRole('button', { name: 'Back to messages', exact: true })
      .click();
    const list = page.getByRole('main', { name: 'Messages', exact: true });
    await expect(list).toBeVisible();
    await list
      .getByRole('button', { name: 'Phone Friend', exact: true })
      .click();
    await expect(composer).toHaveValue('Keep this draft when I go back');
    await swipe(page, [8, safeTop + 90], [150, safeTop + 95]);
    await expect(list).toBeVisible();
    await swipe(page, [398, safeTop + 90], [255, safeTop + 95]);
    await expect(conversation).toBeVisible();
    await expect(composer).toHaveValue('Keep this draft when I go back');
    await conversation
      .getByRole('button', { name: 'Back to messages', exact: true })
      .click();
    await expect(list).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .include('.mobile-room-list')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await list
      .getByRole('searchbox', { name: 'Filter conversations' })
      .fill('does not exist');
    await expect(
      list.getByRole('heading', { name: 'No matches' }),
    ).toBeVisible();
    await list
      .getByRole('searchbox', { name: 'Filter conversations' })
      .fill('Phone');
    await list
      .getByRole('searchbox', { name: 'Filter conversations' })
      .press('Enter');
    await expect(
      list.getByRole('searchbox', { name: 'Filter conversations' }),
    ).not.toBeFocused();
    await list
      .getByRole('button', { name: 'Phone Friend', exact: true })
      .click();
    await expect(composer).toHaveValue('Keep this draft when I go back');

    for (const size of [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 874, height: 402 },
    ]) {
      await page.setViewportSize(size);
      if (cdp)
        await cdp.send('Emulation.setSafeAreaInsetsOverride', {
          insets:
            size.width > size.height
              ? { left: 59, right: 59, bottom: 21 }
              : { top: 20, bottom: 0 },
        });
      await expect(composer).toBeInViewport();
      const box = (await composer.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      for (const name of ['Back to messages', 'Conversation options']) {
        const button = (await conversation
          .getByRole('button', { name, exact: true })
          .boundingBox())!;
        expect(layoutPixels(button.height)).toBeGreaterThanOrEqual(44);
        expect(layoutPixels(button.width)).toBeGreaterThanOrEqual(44);
      }
    }
    await openMobileFriends(page);
    const friends = page.getByRole('dialog', { name: 'Better with friends' });
    await expect(friends).toBeVisible();
    const close = (await friends
      .getByRole('button', { name: 'Close' })
      .boundingBox())!;
    expect(close.x + close.width).toBeLessThanOrEqual(874 - (cdp ? 59 : 0));
    expect(layoutPixels(close.height)).toBeGreaterThanOrEqual(44);
    await friends.getByRole('button', { name: 'Close' }).click();
    await page
      .getByRole('button', { name: 'Mobile Writer and account options' })
      .click();
    await page
      .getByRole('menuitem', { name: 'Recordings', exact: true })
      .click();
    await expect(
      page.getByRole('main', { name: 'Recordings', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Bettercomms home' })
      .click();
    await expect(conversation).toBeHidden();
    await expect(
      page.getByRole('heading', { name: 'HAPPENING NOW' }),
    ).toBeVisible();
  } finally {
    await phone.close();
    await friend.close();
  }
});
