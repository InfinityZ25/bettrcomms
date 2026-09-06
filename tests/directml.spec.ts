import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test('browser rejects stale DeepFilterNet preference and clamps its attenuation setting', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    localStorage.setItem('bc-denoiser', 'deepfilter');
    localStorage.setItem(
      'bc-processing',
      JSON.stringify({ deepfilterAttenuationDb: 180 }),
    );
    const { readProcessingSettings, saveProcessingSettings } =
      await import('/src/media/processingSettings.ts');
    const initial = readProcessingSettings();
    const minimum = saveProcessingSettings({ deepfilterAttenuationDb: -20 });
    return { initial, minimum };
  });

  expect(result.initial).toMatchObject({
    engine: 'standard',
    deepfilterAttenuationDb: 100,
  });
  expect(result.minimum.deepfilterAttenuationDb).toBe(0);
});

test('native settings gate DeepFilterNet on readiness and install the supported component', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let ready = false;
    const commands: string[] = [];
    Object.defineProperty(window, '__directmlCommands', { value: commands });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          commands.push(command);
          if (command === 'deepfilter_status')
            return {
              ready,
              detail: ready ? 'Model probe passed.' : 'Setup is required.',
              adapterName: ready ? 'Test DirectML adapter' : null,
              frameSamples: ready ? 512 : null,
              sampleRate: 48_000,
            };
          if (command === 'deepfilter_install_info')
            return {
              supported: true,
              installed: ready,
              downloadBytes: 52_428_800,
              detail: ready ? 'Installed.' : 'DirectML is supported.',
            };
          if (command === 'deepfilter_install') {
            ready = true;
            return null;
          }
          if (command === 'nvidia_status')
            return {
              ready: false,
              detail: 'NVIDIA is unavailable.',
              frameSamples: null,
              sampleRate: 48_000,
            };
          if (command === 'nvidia_install_info')
            return {
              schemaVersion: 1,
              supported: false,
              installed: false,
              gpuName: null,
              selectedPackage: null,
              downloadBytes: 0,
              detail: 'NVIDIA is unavailable.',
            };
          return null;
        },
      },
    });
  });

  await page.goto(baseURL);
  await page.evaluate(() =>
    Object.defineProperty(window, 'isTauri', { value: true }),
  );
  await page.getByRole('button', { name: /audio and video settings/i }).click();
  const engine = page.getByLabel('Noise suppression engine');
  await expect(engine.locator('option[value="deepfilter"]')).toHaveAttribute(
    'disabled',
    '',
  );
  await expect(
    page.getByText('DeepFilterNet is unavailable: Setup is required.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Download and set up DeepFilterNet' })
    .click();
  await expect(
    engine.locator('option[value="deepfilter"]'),
  ).not.toHaveAttribute('disabled', '');
  await expect(
    page.getByText(/DeepFilterNet is ready on Test DirectML adapter/),
  ).toBeVisible();
  await engine.selectOption('deepfilter');
  await page
    .getByRole('slider', { name: 'Maximum noise attenuation' })
    .fill('73');
  await page.getByRole('button', { name: 'Apply microphone settings' }).click();

  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __directmlCommands: string[] })
          .__directmlCommands,
    ),
  ).toContain('deepfilter_install');
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('bc-processing') ?? '{}'),
      ),
    )
    .toMatchObject({ deepfilterAttenuationDb: 73 });
});
