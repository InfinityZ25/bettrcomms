import { openMobileFriends } from './mobile-touch';
import { expect, test } from '@playwright/test';

test('phone sheets keep their full bounds visible after production CSS optimization', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 402, height: 874 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const response = await context.request.post('/api/v1/auth/dev', {
      headers: { Origin: new URL(baseURL!).origin },
      data: {
        name: 'Sheet Tester',
        email: `sheets-${Date.now()}@example.test`,
      },
    });
    expect(response.ok()).toBeTruthy();
    const page = await context.newPage();
    await page.goto('/');
    const cdp =
      browser.browserType().name() === 'chromium'
        ? await context.newCDPSession(page)
        : null;
    for (const size of [
      { width: 402, height: 874 },
      { width: 874, height: 402 },
    ]) {
      await page.setViewportSize(size);
      const top = cdp && size.width < size.height ? 59 : 0;
      const bottom = cdp ? (top ? 34 : 21) : 0;
      if (cdp)
        await cdp.send('Emulation.setSafeAreaInsetsOverride', {
          insets: top ? { top, bottom } : { left: 59, right: 59, bottom },
        });
      await openMobileFriends(page);
      const friends = page.getByRole('dialog', { name: 'Better with friends' });
      await expect(friends).toBeVisible();
      await expect
        .poll(async () => Math.round((await friends.boundingBox())!.x))
        .toBe(0);
      await expect
        .poll(async () => Math.round((await friends.boundingBox())!.y))
        .toBe(0);
      expect(Math.round((await friends.boundingBox())!.width)).toBe(size.width);
      expect(Math.round((await friends.boundingBox())!.height)).toBe(
        size.height,
      );
      await friends.getByRole('button', { name: 'Close', exact: true }).click();
      await page
        .getByRole('button', { name: 'Sheet Tester and account options' })
        .click();
      await page
        .getByRole('menuitem', { name: 'Settings', exact: true })
        .click();
      const settings = page.getByRole('dialog', {
        name: 'Settings',
        exact: true,
      });
      await expect(settings).toBeVisible();
      await expect
        .poll(async () => Math.round((await settings.boundingBox())!.x))
        .toBe(0);
      await expect
        .poll(async () => Math.round((await settings.boundingBox())!.y))
        .toBe(0);
      expect(Math.round((await settings.boundingBox())!.width)).toBe(
        size.width,
      );
      expect(Math.round((await settings.boundingBox())!.height)).toBe(
        size.height,
      );
      // Safe areas protect controls, not an inset rectangle of a different
      // color. The scrolling surface continues to the physical bottom edge.
      expect(
        await settings.evaluate(
          (node) => getComputedStyle(node).backgroundColor,
        ),
      ).toBe(
        await settings
          .locator('main')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      );
      const category = settings.getByRole('combobox', {
        name: 'Settings category',
      });
      await expect(category).toBeVisible();
      expect((await category.boundingBox())!.y).toBeGreaterThanOrEqual(top);
      expect(
        (await settings
          .getByRole('button', { name: 'Close', exact: true })
          .boundingBox())!.y,
      ).toBeGreaterThanOrEqual(top);
      const scroll = (await settings
        .locator('.settings-scroll')
        .boundingBox())!;
      expect(Math.round(scroll.y + scroll.height)).toBe(size.height);
      await settings
        .getByRole('button', { name: 'Close', exact: true })
        .click();
    }
    await page.setViewportSize({ width: 402, height: 874 });
    if (cdp)
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 59, bottom: 34 },
      });
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Bettercomms home', exact: true })
      .click();
    await page.getByRole('button', { name: /^New room/ }).click();
    const room = page.getByRole('dialog', { name: 'Make room for your friends' });
    await expect(room).toBeVisible();
    const box = (await room.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 201)).toBeLessThan(1);
    expect(Math.abs(box.y + box.height / 2 - 437)).toBeLessThan(1);
    await room
      .getByRole('textbox', { name: 'Room name' })
      .fill('Keyboard test');
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', {
        configurable: true,
        get: () => 450,
      });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect
      .poll(async () => {
        const bounds = (await room.boundingBox())!;
        return Math.round(bounds.y + bounds.height / 2);
      })
      .toBe(225);
    await expect(
      room.getByRole('button', { name: 'Create room' }),
    ).toBeInViewport();
  } finally {
    await context.close();
  }
});
