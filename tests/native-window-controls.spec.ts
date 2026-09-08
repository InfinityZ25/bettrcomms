import { expect, test } from '@playwright/test';

// Verifies the page/host contract, not native Win32 input or Snap Layouts.
test('native frame hides the HTML caption and follows the actual CSS palette', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const host = window as any;
    host.isTauri = true;
    host.__captionEvents = [];
    host.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        if (command === 'plugin:event|emit_to') host.__captionEvents.push(args);
        return command === 'plugin:window|is_maximized' ? false : 1;
      },
    };
    host.__BETTER_WINDOW_CONTROLS__ = {
      platform: 'windows', mode: 'native-frame', height: 0,
      insetStart: 0, insetEnd: 0, buttons: [], buttonSide: 'end',
    };
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: Frame } = await import('/src/features/shell/DesktopFrame.tsx');
    const fixture = document.createElement('div');
    document.body.replaceChildren(fixture);
    host.__captionRoot = ReactDOM.createRoot(fixture);
    host.__captionRoot.render(React.createElement(Frame, null,
      React.createElement('main', { 'data-testid': 'content' }, 'Client content')));
  });
  await expect(page.getByTestId('content')).toBeVisible();
  await expect(page.locator('[data-desktop-frame]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /window$/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__captionEvents.length)).toBeGreaterThan(0);
  const initial = await page.evaluate(() => (window as any).__captionEvents.at(-1));
  expect(initial.target).toEqual({ kind: 'Webview', label: 'main' });
  expect(initial.event).toBe('better-gui:caption-theme');
  expect(initial.payload.background).toEqual([29, 24, 22]);
  expect(initial.payload.dark).toBe(true);

  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    document.documentElement.style.setProperty('--sidebar', 'rgb(23, 45, 67)');
  });
  await expect.poll(() => page.evaluate(() => (window as any).__captionEvents.at(-1).payload))
    .toMatchObject({ background: [23, 45, 67], dark: false });

  const beforeCleanup = await page.evaluate(() => {
    (window as any).__captionRoot.unmount();
    return (window as any).__captionEvents.length;
  });
  await page.evaluate(() => document.documentElement.style.setProperty('--sidebar', 'rgb(1, 2, 3)'));
  // Cross two animation frames: a leaked observer would publish in this interval.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as any).__captionEvents.length)).toBe(beforeCleanup);
});
