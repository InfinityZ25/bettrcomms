// Run against an isolated development desktop host; never joins a real call.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.connectOverCDP(process.env.BETTERCOMMS_OVERLAY_CDP ?? 'http://127.0.0.1:9225');
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(page => /localhost:5173|127\.0\.0\.1:5173/.test(page.url()));
  assert.ok(page, 'Isolated local desktop page required');
  const result = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const { CameraOverlayCanvas } = await import('/src/media/cameraOverlayCanvas.ts');
    const source = document.createElement('canvas'); source.width = 320; source.height = 180;
    const graphics = source.getContext('2d');
    graphics.fillStyle = '#62884b'; graphics.fillRect(0, 0, 320, 180);
    const track = source.captureStream(24).getVideoTracks()[0];
    const compositor = new CameraOverlayCanvas();
    let session;
    const send = async (rgba, id = session.overlayId) => invoke('camera_overlay_frame', rgba, { headers: {
      'x-bettercomms-overlay-id': id,
      'x-bettercomms-frame-width': String(session.width),
      'x-bettercomms-frame-height': String(session.height),
    } });
    const rejected = async operation => { try { await operation(); return false; } catch { return true; } };
    try {
      session = await invoke('camera_overlay_open', { position: 'top-right', size: 'small', clickThrough: true, rows: 1 });
      if (session.maxFps !== 24) throw new Error('Expected the 24 FPS native host');
      const cameras = [1].map(n => ({ id: String(n), name: 'Synthetic camera ' + n, track, speaking: n === 1, muted: n === 2 }));
      const samples = []; const completed = [];
      for (let n = 0; n < 48; n++) {
        const time = performance.now();
        await send(compositor.render(cameras, session.width, session.height));
        samples.push(performance.now() - time); completed.push(performance.now());
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const badTokenRejected = await rejected(() => send(new Uint8Array(session.width * session.height * 4), 'invalid'));
      const badFrameRejected = await rejected(() => send(new Uint8Array(8)));
      session = await invoke('camera_overlay_update', { overlayId: session.overlayId, rows: 4, size: 'large', position: 'bottom-left', clickThrough: false });
      const resized = { width: session.width, height: session.height };
      await send(compositor.render(cameras, session.width, session.height));
      await invoke('camera_overlay_close', { overlayId: session.overlayId });
      const closedRejected = await rejected(() => send(new Uint8Array(session.width * session.height * 4)));
      compositor.dispose();
      const sourceStillLive = track.readyState === 'live';
      return { steadyFps: (completed.length - 1) * 1000 / (completed.at(-1) - completed[0]), badTokenRejected, badFrameRejected, closedRejected, sourceStillLive, resized, meanFrameMs: samples.reduce((a, b) => a + b, 0) / samples.length, maxFrameMs: Math.max(...samples) };
    } finally {
      if (session) await invoke('camera_overlay_close', { overlayId: session.overlayId }).catch(() => {});
      compositor.dispose(); track.stop();
    }
  });
  assert.equal(result.badTokenRejected, true);
  assert.equal(result.badFrameRejected, true);
  assert.equal(result.closedRejected, true);
  assert.equal(result.sourceStillLive, true);
  assert.ok(result.resized.height <= 900);
  assert.ok(result.steadyFps >= 23 && result.steadyFps <= 25, 'Overlay must sustain approximately 24fps in this isolated test');
  console.log(JSON.stringify(result, null, 2));
  await page.evaluate(async () => {
    const main = await fetch('/src/main.tsx').then(response => response.text());
    const reactUrl = main.match(/from "([^"]*\/react\.js[^\"]*)"/)[1];
    const domUrl = main.match(/from "([^"]*\/react-dom_client\.js[^\"]*)"/)[1];
    const [{ default: React }, { default: ReactDOM }, { default: CameraOverlay }] = await Promise.all([import(reactUrl), import(domUrl), import('/src/CameraOverlay.tsx')]);
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const graphics = canvas.getContext('2d'); graphics.fillStyle = '#607f47'; graphics.fillRect(0, 0, 320, 180);
    const track = canvas.captureStream(24).getVideoTracks()[0];
    const container = document.createElement('div'); container.style.cssText = 'position:fixed;right:50px;top:80px;z-index:99999'; document.body.append(container);
    const root = ReactDOM.createRoot(container);
    root.render(React.createElement(CameraOverlay, { cameras: [{ id: 'synthetic', name: 'Synthetic friend', track }] }));
    window.__overlayTestCleanup = () => { root.unmount(); container.remove(); track.stop(); };
  });
  try {
    await page.locator('.camera-overlay-controls > summary').click();
    await page.getByRole('button', { name: 'Show camera overlay', exact: true }).click();
    await page.getByRole('button', { name: 'Hide camera overlay', exact: true }).waitFor();
    await page.waitForTimeout(1500);
    await page.getByRole('combobox', { name: 'Overlay camera size' }).selectOption('medium');
    await page.getByRole('combobox', { name: 'Overlay screen corner' }).selectOption('bottom-right');
    await page.waitForTimeout(500);
    await page.screenshot({ path: '.local/overlay-panel.png' });
    await page.getByRole('button', { name: 'Hide camera overlay', exact: true }).click();
    await page.getByRole('button', { name: 'Show camera overlay', exact: true }).waitFor();
    console.log('Native overlay controls passed');
  } finally { await page.evaluate(() => window.__overlayTestCleanup?.()); }
} finally { await browser.close(); }
