import { expect, test } from '@playwright/test';

// Use the actual application CSS and content inside the custom-frame DOM.
// This checks layout, not native caption dragging/window-button behavior.
test('custom desktop frames fill the space below the titlebar at phone breakpoints', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-app-shell]')).toBeVisible();
  await page.evaluate(() => {
    const shell = document.querySelector('[data-app-shell]')!;
    const frame = document.createElement('div');
    frame.dataset.desktopFrame = '';
    frame.className = 'flex h-dvh w-full flex-col overflow-hidden';
    const bar = document.createElement('div');
    bar.className = 'better-window-titlebar shrink-0';
    bar.style.height = '40px';
    shell.parentNode!.insertBefore(frame, shell);
    frame.append(bar, shell);
  });
  for (const size of [{ width: 1280, height: 800 }, { width: 800, height: 800 }, { width: 960, height: 440 }, { width: 600, height: 700 }]) {
    await page.setViewportSize(size);
    const shell = page.locator('[data-app-shell]');
    await expect.poll(async () => Math.round((await shell.boundingBox())!.height)).toBe(size.height - 40);
    expect(Math.round((await shell.boundingBox())!.y)).toBe(40);
    await expect(page.getByRole('button', { name: /Continue with WorkOS/ })).toBeVisible();
  }
});
