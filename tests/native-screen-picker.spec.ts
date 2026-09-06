import { expect, test, type Page } from '@playwright/test';
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
async function mount(
  page: Page,
  systemAudioAvailable = true,
  applicationAudioAvailable = true,
) {
  await page.goto(baseURL);
  await page.evaluate(async ({ systemAudioAvailable, applicationAudioAvailable }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#213b45';
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#9fc380';
    ctx.fillRect(24, 24, 160, 312);
    ctx.fillStyle = '#dde6dc';
    ctx.font = '24px sans-serif';
    ctx.fillText('Preview fixture', 214, 70);
    const jpeg = await (
      await fetch(canvas.toDataURL('image/jpeg'))
    ).arrayBuffer();
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: { sourceId?: string }) => {
        if (command === 'native_system_audio_capabilities')
          return {
            available: systemAudioAvailable,
            applicationAudio: applicationAudioAvailable,
            detail: systemAudioAvailable
              ? 'Ready'
              : 'System audio is unavailable on this Windows version.',
          };
        if (command === 'native_screen_capabilities')
          return {
            available: true,
            version: 1,
            detail: '',
            encoders: [
              {
                id: 'h264_amf',
                label: 'AMD hardware H.264',
                available: true,
                reason: '',
              },
              {
                id: 'h264_nvenc',
                label: 'NVIDIA hardware H.264',
                available: false,
                reason: 'No adapter',
              },
            ],
          };
        if (command === 'native_screen_thumbnail') {
          ((window as any).__previewRequests ??= []).push(args?.sourceId);
          return jpeg;
        }
        if (command === 'native_screen_sources')
          return {
            sources: [
              ...Array.from({ length: 20 }, (_, i) => ({
                id: String(i),
                name:
                  i === 0
                    ? 'C:\\Users\\AnExtremelyLongUnbrokenWindowName'.repeat(5)
                    : `Application ${i}`,
                kind: 'window',
                width: 1920,
                height: 1080,
                category: i === 1 ? 'game' : 'app',
                minimized: i === 1,
              })),
              {
                id: 'monitor',
                name: 'Main monitor',
                kind: 'monitor',
                width: 3840,
                height: 2160,
              },
            ],
          };
      },
    };
    const { default: React } =
      await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOMClient } =
      await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: Picker } = await import('/src/NativeScreenPicker.tsx');
    document.body.innerHTML = '<div id="picker-test"></div>';
    const root = ReactDOMClient.createRoot(
      document.getElementById('picker-test')!,
    );
    let tick = 0;
    (window as any).__rerenderPicker = () =>
      root.render(
        React.createElement(
          'div',
          { 'data-update': ++tick },
          React.createElement(Picker, {
            onShare: async (options: unknown) => {
              (window as any).__shared = options;
            },
            onBrowser: async () => {
              document.body.dataset.browser = 'true';
            },
            onClose: () => {
              document.body.dataset.closed = 'true';
            },
          }),
        ),
      );
    (window as any).__rerenderPicker();
  }, { systemAudioAvailable, applicationAudioAvailable });
  await expect(
    page.getByRole('button', { name: 'Application 1', exact: true }),
  ).toBeVisible();
}
test('dedicated sharing screen keeps controls visible and preserves focus and gallery position', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('main', { name: 'Share your screen' }),
  ).toBeVisible();
  await expect(page.locator('.share-source-preview img').first()).toBeVisible();
  await page
    .getByRole('button', { name: 'Application 1', exact: true })
    .click();
  await expect(
    page.getByText(/Sharing restores this minimized app/),
  ).toBeVisible();
  await page.getByText('Encoder & bitrate', { exact: true }).click();
  await expect(
    page.getByLabel('Video compatibility', { exact: true }),
  ).toHaveValue('auto');
  await page.getByLabel('Bitrate', { exact: true }).selectOption('8');
  await expect(page.getByLabel('Encoder', { exact: true })).toHaveValue(
    'h264_amf',
  );
  await expect(page.getByRole('option', { name: /NVIDIA/ })).toHaveAttribute(
    'disabled',
    '',
  );
  const gallery = page.locator('.share-source-scroll');
  await gallery.evaluate((el) => {
    el.scrollTop = 450;
  });
  const scroll = await gallery.evaluate((el) => el.scrollTop);
  expect(scroll).toBeGreaterThan(100);
  await page.getByLabel('Frame rate', { exact: true }).focus();
  for (let i = 2; i <= 4; i++) {
    await page.evaluate(() => (window as any).__rerenderPicker());
    await expect(page.locator('[data-update]')).toHaveAttribute(
      'data-update',
      String(i),
    );
    await expect(page.getByLabel('Frame rate', { exact: true })).toBeFocused();
    expect(await gallery.evaluate((el) => el.scrollTop)).toBe(scroll);
  }
  await expect(
    page.getByRole('button', { name: 'Share', exact: true }),
  ).toBeInViewport();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__shared)).toMatchObject({
    sourceId: '1',
    width: 0,
    height: 0,
    fps: 60,
    bitrateMbps: 8,
    h264Profile: 'auto',
    encoder: 'h264_amf',
    systemAudio: true,
    systemAudioSourceId: '1',
    displayBorder: false,
  });

  await page.getByLabel('Share application audio', { exact: true }).uncheck();
  await page.getByLabel('Show capture border', { exact: true }).check();
  await page.evaluate(() => {
    (window as any).__shared = undefined;
  });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__shared)).toMatchObject({
    sourceId: '1',
    systemAudio: false,
    displayBorder: true,
  });
  await gallery.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: '.local/share-screen-desktop.png' });
  await page
    .getByRole('button', { name: 'Entire screen', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Main monitor', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Use browser sharing', exact: true })
    .click();
  await expect(page.locator('body')).toHaveAttribute('data-browser', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute('data-closed', 'true');
});

test('unavailable native audio is disabled and keeps browser sharing actionable', async ({
  page,
}) => {
  await mount(page, false);
  const audio = page.getByLabel('Share application audio', { exact: true });
  await expect(audio).toBeDisabled();
  await expect(audio).not.toBeChecked();
  await expect(
    page.getByText('System audio is unavailable on this Windows version.'),
  ).toBeVisible();
  const fallback = page.getByRole('button', {
    name: 'Use browser sharing',
    exact: true,
  });
  await expect(fallback).toBeEnabled();
  await fallback.click();
  await expect(page.locator('body')).toHaveAttribute('data-browser', 'true');
});

test('application audio requires the new host capability and never starts implicitly', async ({ page }) => {
  await mount(page, true, false);
  await page.getByRole('button', { name: 'Application 1', exact: true }).click();
  await expect(page.getByLabel('Share application audio', { exact: true })).toBeDisabled();
  await expect(page.getByText(/Update the desktop app for application audio/)).toBeVisible();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__shared)).toMatchObject({
    sourceId: '1',
    systemAudio: false,
  });
  expect(await page.evaluate(() => (window as any).__shared.systemAudioSourceId)).toBeUndefined();
});

test('window sharing distinguishes selected-application audio from explicit system audio', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: 'Application 1', exact: true }).click();
  await expect(page.getByLabel('Share application audio', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__shared.systemAudioSourceId)).toBe('1');

  await page.getByLabel('Audio source').selectOption('system');
  await expect(page.getByLabel('Share system audio', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const shared = await page.evaluate(() => (window as any).__shared);
  expect(shared.systemAudio).toBe(true);
  expect(shared.systemAudioSourceId).toBeUndefined();
});
test('source names never create horizontal scrolling across desktop and mobile widths', async ({
  page,
}) => {
  await mount(page);
  for (const size of [
    { width: 1280, height: 900 },
    { width: 960, height: 640 },
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(size);
    await expect(
      page.getByRole('button', { name: 'Share', exact: true }),
    ).toBeInViewport();
    const overflow = await page
      .locator('.share-screen')
      .evaluate((el) =>
        [
          el,
          ...el.querySelectorAll<HTMLElement>(
            '.share-screen-body,.share-source-scroll,.share-source-grid,.share-setup',
          ),
        ]
          .filter((node) => node.scrollWidth > node.clientWidth + 1)
          .map((node) => node.className),
      );
    expect(overflow).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('searchbox', { name: 'Find a source' })
    .fill('Application 1');
  await expect(page.locator('.share-source-card')).toHaveCount(11);
  await page.screenshot({ path: '.local/share-screen-mobile.png' });
});

test('visible previews are cached across search and tabs, and explicitly refreshed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page);
  const first = page.locator('.share-source-card').first();
  await expect(first.locator('img')).toBeVisible();
  const calls = () =>
    page.evaluate(() => (window as any).__previewRequests as string[]);
  expect((await calls()).length).toBeLessThan(20);
  const firstName = await first.getAttribute('aria-label');
  const before = (await calls()).filter((id) => id === '0').length;
  await page
    .getByRole('button', { name: 'Entire screen', exact: true })
    .click();
  await expect(page.locator('.share-source-preview img')).toBeVisible();
  await page.getByRole('button', { name: 'Applications', exact: true }).click();
  await expect(
    page.locator('.share-source-card').first().locator('img'),
  ).toBeVisible();
  await page.getByLabel('Find a source').fill('Application 19');
  await expect(page.locator('.share-source-preview img')).toBeVisible();
  await page.getByLabel('Find a source').fill(firstName!);
  await expect(page.locator('.share-source-preview img')).toBeVisible();
  expect((await calls()).filter((id) => id === '0')).toHaveLength(before);
  await page
    .getByRole('button', { name: 'Refresh sources', exact: true })
    .click();
  await expect
    .poll(async () => (await calls()).filter((id) => id === '0').length)
    .toBe(before + 1);
  await expect(page.locator('.share-source-preview img')).toBeVisible();
});

test('failed previews do not retry and block other visible sources', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page);
  await expect(page.locator('.share-source-preview img').first()).toBeVisible();
  await page.evaluate(() => {
    const host = (window as any).__TAURI_INTERNALS__;
    const original = host.invoke;
    (window as any).__failedPreviews = [];
    host.invoke = async (command: string, args: any) => {
      if (command === 'native_screen_thumbnail') {
        (window as any).__failedPreviews.push(args.sourceId);
        throw new Error('Native preview timed out');
      }
      return original(command, args);
    };
  });
  await page
    .getByRole('button', { name: 'Refresh sources', exact: true })
    .click();
  await expect(
    page.getByText('Preview unavailable · refresh sources above').first(),
  ).toBeVisible();
  await page.getByLabel('Find a source').fill('Application 19');
  await expect(
    page.getByText('Preview unavailable · refresh sources above'),
  ).toBeVisible();
  const calls = await page.evaluate(
    () => (window as any).__failedPreviews as string[],
  );
  expect(calls).toContain('19');
  expect(calls.filter((id) => id === '0')).toHaveLength(1);
});
