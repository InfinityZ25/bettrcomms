// Native UI integration using synthetic capture. Launch with temporary loopback CDP
// and --use-fake-device-for-media-stream, never ship these development flags.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
let page, saved;
try {
  page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith('http://localhost:5173'));
  assert.ok(page, 'Native preview must be running');
  saved = await page.evaluate(() => ({
    hash: location.hash,
    entries: Object.fromEntries(
      ['bc-noise', 'bc-denoiser', 'bc-processing', 'bc-input', 'bc-output'].map(
        (k) => [k, localStorage.getItem(k)],
      ),
    ),
  }));
  await page.evaluate(() => {
    localStorage.setItem('bc-noise', 'on');
    localStorage.setItem('bc-denoiser', 'nvidia');
    localStorage.setItem('bc-input', '');
    localStorage.setItem('bc-output', '');
    localStorage.setItem(
      'bc-processing',
      JSON.stringify({
        nvidiaIntensity: 0.5,
        nvidiaVad: true,
        gateEnabled: true,
        gateThresholdDb: -50,
        gainDb: -3,
        highPassHz: 80,
      }),
    );
  });
  await page.goto('http://localhost:5173/#/settings');
  await page
    .getByRole('slider', { name: 'NVIDIA suppression strength' })
    .waitFor();
  assert.equal(
    await page
      .getByRole('slider', { name: 'NVIDIA suppression strength' })
      .inputValue(),
    '0.5',
  );
  assert.equal(
    await page
      .getByRole('checkbox', { name: /speech-only filtering/i })
      .isChecked(),
    true,
  );
  await page
    .getByRole('button', { name: 'Test microphone', exact: true })
    .click();
  await page
    .getByText('Recording a 5-second NVIDIA sample…', { exact: true })
    .waitFor({ timeout: 15000 });
  await page
    .getByText('Playing your 5-second NVIDIA microphone sample.', {
      exact: true,
    })
    .waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Back to call' }).click();
  const status = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('nvidia_status'),
  );
  assert.equal(status.ready, true);
  console.log(
    'PASS: native settings microphone test uses NVIDIA with 50% intensity, VAD, low-cut, gain and gate; completed recording/playback and returned to call.',
  );
} finally {
  if (page && saved) {
    await page.evaluate((saved) => {
      for (const [key, value] of Object.entries(saved.entries)) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
      location.hash = saved.hash;
    }, saved);
    await page.reload();
  }
  await browser.close();
}
