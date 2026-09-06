// Use a temporary loopback CDP endpoint and --use-fake-device-for-media-stream.
// Do not use --use-fake-ui-for-media-stream: that would hide permission failures.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith('http://localhost:5173'));
  assert.ok(page, 'Native development preview is required');
  const result = await page.evaluate(async () => {
    const invoke = (command, args) =>
      window.__TAURI_INTERNALS__.invoke(command, args);
    const checks = [];
    for (const kind of ['microphone', 'camera']) {
      try {
        await invoke('desktop_media_permission_set', { kind, allowed: false });
        const denied = await invoke('desktop_media_permission_status', {
          kind,
        });
        let rejected = false;
        try {
          const stream = await navigator.mediaDevices.getUserMedia(
            kind === 'camera' ? { video: true } : { audio: true },
          );
          stream.getTracks().forEach((t) => t.stop());
        } catch (e) {
          rejected = e.name === 'NotAllowedError';
        }
        await invoke('desktop_media_permission_set', { kind, allowed: true });
        const allowed = await invoke('desktop_media_permission_status', {
          kind,
        });
        const stream = await navigator.mediaDevices.getUserMedia(
          kind === 'camera' ? { video: true } : { audio: true },
        );
        const tracks = stream.getTracks();
        const live = tracks.every((t) => t.readyState === 'live');
        tracks.forEach((t) => t.stop());
        checks.push({
          kind,
          denied: denied.state,
          allowed: allowed.state,
          rejected,
          live,
          stopped: tracks.every((t) => t.readyState === 'ended'),
        });
      } finally {
        await invoke('desktop_media_permission_set', { kind, allowed: true });
      }
    }
    return checks;
  });
  for (const [index, kind] of ['microphone', 'camera'].entries())
    assert.deepEqual(result[index], {
      kind,
      denied: 'denied',
      allowed: 'allowed',
      rejected: true,
      live: true,
      stopped: true,
    });
  console.log(
    'PASS: native microphone and camera deny/re-enable recovery; synthetic capture and cleanup, without browser permission UI.',
  );
} finally {
  await browser.close();
}
