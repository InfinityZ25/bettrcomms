import { expect, test } from '@playwright/test';
import { openMobileFriends, swipe } from './mobile-touch';

test('edge swipes restore mobile screens and sheets while keeping a call connected', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 402, height: 874 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const headers = { Origin: new URL(baseURL!).origin };
    const response = await context.request.post('/api/v1/auth/dev', {
      headers,
      data: { name: 'Swipe Tester', email: `swipe-${Date.now()}@example.test` },
    });
    expect(response.ok()).toBeTruthy();
    const created = await context.request.post('/api/v1/rooms', {
      headers,
      data: { name: 'Swipe room' },
    });
    expect(created.ok()).toBeTruthy();
    const page = await context.newPage();
    await page.goto('/');
    const liveCall = browser.browserType().name() === 'chromium';
    // Chromium uses its synthetic microphone. Headless WebKit cannot obtain
    // OS capture permission, so it checks navigation from the call lobby.
    if (liveCall)
      await page
        .getByRole('button', { name: 'Join call', exact: true })
        .click();
    await expect(
      page.getByRole('button', {
        name: liveCall ? 'Leave call' : 'Join call',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Messages', exact: true })
      .click();
    const messages = page.getByRole('main', { name: 'Messages', exact: true });
    await expect(messages).toBeVisible();
    // Vertical scrolling and short/central swipes are not navigation.
    await swipe(page, [8, 120], [12, 230]);
    await expect(messages).toBeVisible();
    await swipe(page, [8, 120], [30, 122]);
    await expect(messages).toBeVisible();
    await swipe(page, [170, 120], [300, 120]);
    await expect(messages).toBeVisible();
    await swipe(page, [8, 120], [150, 125]);
    await expect(messages).toBeHidden();
    if (liveCall)
      await expect(
        page.getByRole('button', { name: 'Leave call', exact: true }),
      ).toBeVisible();
    await swipe(page, [398, 55], [255, 60]);
    await expect(messages).toBeVisible();
    if (liveCall)
      await expect(
        page.getByRole('button', { name: 'Leave call', exact: true }),
      ).toBeVisible();
    await page
      .getByRole('button', { name: 'Swipe Tester and account options' })
      .click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', {
      name: 'Settings',
      exact: true,
    });
    await expect(settings).toBeVisible();
    // Sliders keep their own horizontal drag, including near an edge.
    await swipe(page, [8, 120], [180, 120], '[data-slot="slider"]');
    await expect(settings).toBeVisible();
    await swipe(page, [8, 120], [150, 125]);
    await expect(settings).toBeHidden();
    await swipe(page, [398, 120], [255, 125]);
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(settings).toBeHidden();
    // A Close button also leaves the panel in forward history.
    await swipe(page, [398, 120], [255, 125]);
    await expect(settings).toBeVisible();
    await swipe(page, [8, 120], [150, 125]);
    await expect(settings).toBeHidden();
    await openMobileFriends(page);
    const friends = page.getByRole('dialog', { name: 'Better with friends' });
    await expect(friends).toBeVisible();
    await swipe(page, [8, 120], [150, 125]);
    await expect(friends).toBeHidden();
    if (liveCall)
      await expect(
        page.getByRole('button', { name: 'Leave call', exact: true }),
      ).toBeVisible();
  } finally {
    await context.close();
  }
});
