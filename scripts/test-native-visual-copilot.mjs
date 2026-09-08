// Opt-in acceptance: captures only its own synthetic window; uses an isolated
// local debug host. No screen coordinates or capture handles are sent by IPC.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const processId = Number(process.env.BETTERCOMMS_NATIVE_PROCESS_ID);
assert.ok(Number.isInteger(processId) && processId > 0, 'Set the isolated native host PID');
const host = await chromium.connectOverCDP(process.env.BETTERCOMMS_NATIVE_CDP ?? 'http://127.0.0.1:9223', { noDefaults: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const inspect = (focus = false) => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', 'scripts/inspect-copilot-fixture.ps1', '-AppProcessId', String(processId), ...(focus ? ['-FocusFixture'] : [])], { encoding: 'utf8', windowsHide: true }));
let app, session;
try {
  app = host.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://localhost:5173/'));
  assert.ok(app, 'Open the current local desktop host');
  const source = await browser.newPage();
  await source.setContent('<title>BetterComms Copilot Fixture</title><body style="margin:0;background:#15374b;color:white;font:32px sans-serif"><canvas width="800" height="600"></canvas><script>const c=document.querySelector("canvas"),x=c.getContext("2d");function draw(t){x.fillStyle="#15374b";x.fillRect(0,0,800,600);x.fillStyle="#cfff88";x.fillText("Copilot fixture "+Math.floor(t/100),30,100);requestAnimationFrame(draw)}requestAnimationFrame(draw)</script>');
  await source.bringToFront();
  let target;
  for (let attempt = 0; attempt < 30 && !target; attempt++) {
    await source.bringToFront();
    target = await app.evaluate(async () => {
      const result = await window.__TAURI_INTERNALS__.invoke('native_screen_sources');
      return result.sources.find(s => s.name.includes('BetterComms Copilot Fixture'));
    });
    if (!target) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target, 'Capture only the fixture');
  session = await app.evaluate(sourceId => window.__TAURI_INTERNALS__.invoke('native_screen_start', { sourceId, encoder: 'h264_nvenc', width: 1280, height: 720, fps: 30, bitrateMbps: 8, cursor: false }), target.id);
  const focused = inspect(true);
  assert.ok(focused.find(w => w.Title === 'fixture')?.Foreground, `The fixture must own foreground before the test: ${JSON.stringify(focused)}`);
  const frame = (id, corner = 'point', sessionId = session.sessionId) => app.evaluate(async ({ id, corner, sessionId }) => {
    const c = document.createElement('canvas'); c.width = 180; c.height = 180;
    const x = c.getContext('2d'); x.strokeStyle = '#cfff88'; x.lineWidth = 4; x.beginPath(); x.arc(90, 90, 22, 0, Math.PI * 2); x.stroke();
    return window.__TAURI_INTERNALS__.invoke('copilot_overlay_frame', new Uint8Array(x.getImageData(0, 0, 180, 180).data.buffer), { headers: {
      'x-copilot-id': id, 'x-copilot-session': sessionId, 'x-copilot-corner': corner, 'x-copilot-width': '180', 'x-copilot-height': '180', 'x-copilot-x': '0.5', 'x-copilot-y': '0.5',
    } });
  }, { id, corner, sessionId });
  // Keep the lease renewed while a separate PowerShell process inspects windows.
  await frame('native-ping');
  await app.evaluate(sessionId => {
    window.copilotRenewal = setInterval(async () => {
      const c = document.createElement('canvas'); c.width = 180; c.height = 180;
      const x = c.getContext('2d'); x.strokeStyle = '#cfff88'; x.lineWidth = 4; x.beginPath(); x.arc(90, 90, 22, 0, Math.PI*2); x.stroke();
      await window.__TAURI_INTERNALS__.invoke('copilot_overlay_frame', new Uint8Array(x.getImageData(0,0,180,180).data.buffer), { headers: { 'x-copilot-id': 'native-ping', 'x-copilot-session': sessionId, 'x-copilot-corner':'point', 'x-copilot-width':'180', 'x-copilot-height':'180', 'x-copilot-x':'0.5', 'x-copilot-y':'0.5' } }).catch(() => {});
    }, 300);
  }, session.sessionId);
  const initial = inspect();
  const fixture = initial.find(w => w.Title === 'fixture'), overlay = initial.find(w => w.Title === 'overlay');
  assert.ok(fixture && overlay, JSON.stringify(initial));
  assert.ok(overlay.Visible && fixture.Foreground, `Overlay must not steal focus: ${JSON.stringify(initial)}`);
  assert.equal(overlay.Affinity, 0x11, 'Overlay must be excluded from capture');
  assert.ok(overlay.Style & 0x20, 'Clicks must pass through');
  assert.ok(overlay.Style & 0x08000000, 'Overlay must not activate');
  assert.ok(Math.abs((overlay.Bounds.Left + 90) - (fixture.Bounds.Left + fixture.Bounds.Right) / 2) <= 2, 'Horizontal position must map to actual captured window');
  assert.ok(Math.abs((overlay.Bounds.Top + 90) - (fixture.Bounds.Top + fixture.Bounds.Bottom) / 2) <= 2, 'Vertical position must map to actual captured window');
  const cdp = await browser.newBrowserCDPSession();
  const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId: (await (await source.context().newCDPSession(source)).send('Target.getTargetInfo')).targetInfo.targetId });
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: (bounds.left ?? 0) + 40, top: (bounds.top ?? 0) + 30 } });
  const moved = inspect(true); const movedOverlay = moved.find(w => w.Title === 'overlay'); const movedFixture = moved.find(w => w.Title === 'fixture');
  assert.ok(movedOverlay && movedFixture);
  assert.ok(Math.abs(movedOverlay.Bounds.Left + 90 - (movedFixture.Bounds.Left + movedFixture.Bounds.Right) / 2) <= 2, `Overlay follows window movement: ${JSON.stringify(moved)}`);
  const other = await browser.newPage();
  await other.setContent('<title>BetterComms Other Fixture</title><p>Unrelated foreground window</p>');
  await other.bringToFront();
  const hidden = inspect();
  assert.equal(hidden.find(w => w.Title === 'fixture')?.Foreground, false, 'The source must really lose Windows foreground ownership');
  assert.equal(hidden.find(w => w.Title === 'overlay')?.Visible, false, 'Point is hidden above unrelated foreground windows');
  await other.close();
  await app.evaluate(() => clearInterval(window.copilotRenewal));
  await app.evaluate(() => window.__TAURI_INTERNALS__.invoke('copilot_overlay_clear'));
  assert.equal(inspect().filter(w => w.Title === 'overlay').length, 0, 'Explicit clear destroys overlay windows');
  await source.bringToFront(); inspect(true); await frame('card', 'top-right');
  // Inspection takes longer than the 1.2-second lease; the unrenewed card must disappear.
  await new Promise(resolve => setTimeout(resolve, 1400));
  assert.equal(inspect().filter(w => w.Title === 'overlay').length, 0, 'Abandoned overlay expires');
  // Exercise the actual TypeScript receiver -> renderer -> Rust path as well.
  // The track only associates this controlled native session with the renderer;
  // capture itself is the real WGC session already running above.
  inspect(true);
  await app.evaluate(async sessionId => {
    const { VisualCopilot, copilotDefaults, writeCopilotSettings } = await import('/src/media/visualCopilot.ts');
    const { registerNativeScreenTrack } = await import('/src/media/nativeCaptureRegistry.ts');
    const { attachCopilotOverlay } = await import('/src/media/copilotOverlay.ts');
    const before = localStorage.getItem('bc-visual-copilot-v1');
    writeCopilotSettings({ ...copilotDefaults, enabled: true, duration: 4 });
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d'); context.fillStyle = '#197b45'; context.fillRect(0,0,640,360);
    context.strokeStyle = '#cfff88'; context.lineWidth = 4; context.strokeRect(280,140,80,80);
    const track = canvas.captureStream(1).getVideoTracks()[0]; registerNativeScreenTrack(track, sessionId);
    const owner = new VisualCopilot(), viewer = new VisualCopilot();
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    owner.attach('viewer', a); viewer.attach('owner', b); owner.setSource(track);
    window.copilotUiStatus = '';
    const detach = attachCopilotOverlay(owner, () => ({ viewer: 'Native Viewer' }), status => window.copilotUiStatus = status);
    window.copilotUiCleanup = () => { detach(); owner.dispose(); viewer.dispose(); a.close(); b.close(); track.stop(); if (before === null) localStorage.removeItem('bc-visual-copilot-v1'); else localStorage.setItem('bc-visual-copilot-v1', before); };
    const gathered = pc => pc.iceGatheringState === 'complete' ? Promise.resolve() : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local ICE timeout')), 10000);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
    });
    await a.setLocalDescription(); await gathered(a); await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(); await gathered(b); await a.setRemoteDescription(b.localDescription);
    const wait = async predicate => { const end = performance.now() + 10000; while (!predicate()) { if (performance.now() > end) throw new Error('Copilot channel timeout'); await new Promise(r => setTimeout(r, 30)); } };
    await wait(() => owner.getSnapshot().ready.length && viewer.getSnapshot().ready.length);
    owner.grant('viewer', true, true); await wait(() => viewer.getSnapshot().offers.owner);
    viewer.mark('owner', 'ping', .5, .5); await wait(() => owner.getSnapshot().marks.length === 1);
    window.copilotSendLaser = () => viewer.mark('owner', 'ping', .7, .6, undefined, 0, true);
    window.copilotSendCapture = () => viewer.mark('owner', 'snapshot', .5, .5, canvas.toDataURL('image/jpeg', .6), 0);
  }, session.sessionId);
  let actual = inspect(true);
  assert.ok(actual.some(w => w.Title === 'overlay' && w.Visible), `The real frontend renderer presents a received indication: ${JSON.stringify(actual)}; ${await app.evaluate(() => window.copilotUiStatus)}`);
  await app.evaluate(() => window.copilotSendLaser());
  actual = inspect(true);
  const laserSource = actual.find(w => w.Title === 'fixture');
  const sourceWidth = laserSource.Bounds.Right - laserSource.Bounds.Left;
  const sourceHeight = laserSource.Bounds.Bottom - laserSource.Bounds.Top;
  const laserX = laserSource.Bounds.Left + .7 * sourceWidth;
  const laserY = laserSource.Bounds.Top + .6 * sourceHeight;
  assert.ok(actual.some(w => w.Title === 'overlay' && w.Visible && Math.abs(w.Bounds.Left + 90 - laserX) <= 2 && Math.abs(w.Bounds.Top + 90 - laserY) <= 2), `Native laser maps onto the real source window: ${JSON.stringify(actual)}; ${await app.evaluate(() => window.copilotUiStatus)}`);
  await app.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
  await app.evaluate(() => window.copilotSendCapture());
  actual = inspect();
  assert.ok(actual.some(w => w.Title === 'overlay' && w.Bounds.Right - w.Bounds.Left === 320), 'The real frontend renderer presents the received capture card');
  await app.evaluate(() => window.copilotUiCleanup());
  assert.equal(inspect().filter(w => w.Title === 'overlay').length, 0, 'Frontend disposal releases native windows');
  await frame('stop-check');
  await app.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke('native_screen_stop', { sessionId }), session.sessionId);
  assert.equal(inspect().filter(w => w.Title === 'overlay').length, 0, 'Stopping capture destroys indications');
  await assert.rejects(frame('stale'), /ended|changed/);
  session = undefined;
  console.log('PASS native position, window movement, focus, click passthrough styles, capture exclusion, foreground hiding, lease expiry, actual frontend ping/laser/card rendering, laser source coordinates and share-stop cleanup');
} finally {
  if (app) {
    await app.evaluate(() => window.copilotUiCleanup?.()).catch(() => {});
    await app.evaluate(() => clearInterval(window.copilotRenewal)).catch(() => {});
    await app.evaluate(() => window.__TAURI_INTERNALS__.invoke('copilot_overlay_clear')).catch(() => {});
    if (session) await app.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke('native_screen_stop', { sessionId }), session.sessionId).catch(() => {});
  }
  await browser.close(); await host.close();
}
