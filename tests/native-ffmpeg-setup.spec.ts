import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

async function mount(page: Page, mode: 'success' | 'retry' | 'old-binary') {
  await page.goto(baseURL);
  await page.evaluate(async (mode) => {
    let installAttempts = 0;
    const calls: string[] = [];
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          calls.push(command);
          if (command === 'ffmpeg_install_info') {
            if (mode === 'old-binary')
              throw new Error('Command ffmpeg_install_info not found');
            return {
              supported: true,
              installed: installAttempts > 0 && mode === 'success',
              downloadBytes: 247_913_948,
              installedBytes: 223_395_147,
              detail:
                installAttempts > 0 && mode === 'success'
                  ? 'The private FFmpeg 8.1 runtime is ready for native sharing'
                  : 'Install the verified FFmpeg 8.1 runtime privately for BetterComms',
            };
          }
          if (command === 'ffmpeg_install') {
            installAttempts++;
            if (mode === 'retry' && installAttempts === 1)
              throw new Error('Pinned FFmpeg download failed');
            return { installed: true, restartRequired: false };
          }
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    });
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOMClient } =
      await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: Setup } = await import('/src/features/sharing/NativeFfmpegSetup.tsx');
    document.body.innerHTML = '<div id="fixture"></div>';
    ReactDOMClient.createRoot(document.getElementById('fixture')!).render(
      React.createElement(Setup, {
        onInstalled: () => {
          document.body.dataset.installed = 'true';
        },
        onUseBrowser: () => {
          document.body.dataset.browser = 'true';
        },
      }),
    );
    (window as any).__ffmpegCalls = calls;
  }, mode);
}

test('installs the private runtime explicitly and refreshes native sharing', async ({ page }) => {
  await mount(page, 'success');
  await expect(page.getByText(/verified 236 MiB FFmpeg 8\.1 package/)).toBeVisible();
  await page.getByRole('button', { name: 'Install native sharing runtime' }).click();
  await expect(page.getByText(/private FFmpeg 8\.1 runtime is ready/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.dataset.installed)).toBe('true');
  expect(await page.evaluate(() => (window as any).__ffmpegCalls)).toEqual([
    'ffmpeg_install_info',
    'ffmpeg_install',
    'ffmpeg_install_info',
  ]);
});

test('shows a retry after setup failure and succeeds on the next explicit attempt', async ({ page }) => {
  await mount(page, 'retry');
  await page.getByRole('button', { name: 'Install native sharing runtime' }).click();
  await expect(page.getByText(/Pinned FFmpeg download failed/)).toBeVisible();
  await page.getByRole('button', { name: 'Retry runtime setup' }).click();
  await expect.poll(() => page.evaluate(() => document.body.dataset.installed)).toBe('true');
});

test('explains an outdated desktop host and keeps browser sharing available', async ({ page }) => {
  await mount(page, 'old-binary');
  await expect(page.getByText(/Update to BetterComms 0\.1\.1 or newer/i)).toBeVisible();
  await expect(page.getByText(/ffmpeg_install_info not found/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Use browser sharing' }).click();
  await expect.poll(() => page.evaluate(() => document.body.dataset.browser)).toBe('true');
});
