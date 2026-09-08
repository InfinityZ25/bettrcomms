// Opt-in Windows acceptance. Launch an isolated local Tauri host with CDP first.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';

const origin = 'http://localhost:5173';
const lifecycleOnly = process.argv.includes('--lifecycle-only');
const directory = path.resolve('.local/native-ptt-input');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'command.json'), JSON.stringify({ sequence: 0, action: 'snapshot' }));
// Native acceptance must preserve real focus, visibility and the existing WebView viewport.
const browser = await chromium.connectOverCDP(process.env.BETTERCOMMS_PTT_CDP ?? 'http://127.0.0.1:9226', { noDefaults: true });
let sequence = Date.now();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, expected, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let actual;
  do {
    actual = await read();
    if (typeof expected === 'function' ? expected(actual) : actual === expected) return actual;
    await pause(50);
  } while (Date.now() < deadline);
  assert.fail(`${description}: expected ${expected}, received ${JSON.stringify(actual)}`);
}
async function input(action, properties = {}) {
  const id = ++sequence;
  await writeFile(path.join(directory, 'command.json'), JSON.stringify({ sequence: id, action, ...properties }));
  const result = await until(async () => {
    try { return JSON.parse(await readFile(path.join(directory, 'response.json'), 'utf8')); } catch { return null; }
  }, value => value?.sequence === id, `fixture ${action}`);
  assert.equal(result.error, undefined);
  if (action === 'focus') return until(() => input('snapshot'), value => value.foreground, 'external OS focus (unlock Windows before running input acceptance)');
  return result;
}
const page = await until(async () => browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(origin)), value => Boolean(value), 'A local Windows Tauri page is required');
const nativeProcessId = lifecycleOnly ? undefined : Number(await readFile('.local/native-ptt-process', 'utf8'));
const fixture = lifecycleOnly ? undefined : spawn('pwsh', ['-NoProfile', '-File', path.resolve('scripts/test-global-input-fixture.ps1'), '-Directory', directory, '-NativeProcessId', String(nativeProcessId)], { windowsHide: true, stdio: 'ignore' });
let external;
try {
  await page.waitForLoadState('domcontentloaded');
  const capability = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('push_to_talk_capabilities'));
  assert.equal(capability.available, true);
  if (lifecycleOnly) {
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      for (const binding of [
        ...[0, 1, 2, 3, 4].map(button => ({ kind: 'mouse', button })),
        ...['KeyV', 'Space', 'ControlLeft', 'ControlRight', 'NumpadEnter', 'F12'].map(code => ({ kind: 'keyboard', code })),
      ]) {
        const session = await invoke('push_to_talk_start', { binding });
        if (session.pressed || !session.healthy) throw new Error('Registration must start silent and healthy');
        await invoke('push_to_talk_stop', { sessionId: session.sessionId });
      }
      for (const binding of [{ kind: 'mouse', button: 5 }, { kind: 'keyboard', code: 'Escape' }]) {
        let rejected = false;
        try { await invoke('push_to_talk_start', { binding }); } catch { rejected = true; }
        if (!rejected) throw new Error('Invalid binding was accepted');
      }
      const old = await invoke('push_to_talk_start', { binding: { kind: 'mouse', button: 3 } });
      window.pttLease = await invoke('push_to_talk_start', { binding: { kind: 'keyboard', code: 'ControlLeft' } });
      await invoke('push_to_talk_stop', { sessionId: old.sessionId });
      const current = await invoke('push_to_talk_heartbeat', { sessionId: window.pttLease.sessionId });
      if (!current.healthy) throw new Error('A stale stop removed the current registration');
    });
    console.log('PASS native registration, validation, rebinding and stale-session cleanup');
    await pause(5500);
    const expired = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('push_to_talk_heartbeat', { sessionId: window.pttLease.sessionId }));
    assert.equal(expired.healthy, false); assert.equal(expired.pressed, false);
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke('push_to_talk_stop', { sessionId: window.pttLease.sessionId });
      let rejected = false;
      try { await window.__TAURI_INTERNALS__.invoke('push_to_talk_heartbeat', { sessionId: window.pttLease.sessionId }); } catch { rejected = true; }
      if (!rejected) throw new Error('Stopped registration still exists');
    });
    console.log('PASS native lease expiry and explicit stop (no OS input exercised)');
  } else {
  const room = await page.evaluate(async () => {
    localStorage.removeItem('bc-push-to-talk');
    const post = async (url, body) => {
      const response = await fetch('/api/v1' + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Local test setup failed: ${response.status}`);
      return response.json();
    };
    const suffix = Date.now();
    await post('/auth/dev', { name: 'Native PTT test', email: `native-ptt-${suffix}@example.test` });
    return (await post('/rooms', { name: `Native PTT ${suffix}` })).room;
  });
  await page.reload();
  await page.getByRole('button', { name: room.name, exact: true }).waitFor();
  await page.evaluate(async () => {
    const loaded = performance.getEntriesByType('resource').find(entry => /\/src\/media\/engine\.ts(?:\?|$)/.test(entry.name));
    const { MediaEngine } = await import(loaded.name);
    const original = MediaEngine.prototype.setMicrophoneEnabled;
    MediaEngine.prototype.setMicrophoneEnabled = function (enabled) {
      window.pttEngine = this; original.call(this, enabled);
    };
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start(); await context.resume();
    navigator.mediaDevices.getUserMedia = async () => new MediaStream([destination.stream.getAudioTracks()[0].clone()]);
    window.pttSource = context;
  });
  await page.getByRole('button', { name: room.name, exact: true }).click();
  await page.getByRole('button', { name: 'Audio and video settings' }).click();
  const toggle = page.getByRole('checkbox', { name: 'Push-to-talk', exact: true });
  assert.equal(await toggle.isChecked(), false, 'Native mode also defaults off');
  await toggle.check();
  await page.getByRole('button', { name: 'Set push-to-talk shortcut' }).click();
  await page.keyboard.press('ControlLeft');
  await page.getByRole('button', { name: 'Back to call' }).click();
  await page.getByRole('button', { name: 'Join call', exact: true }).click();
  await page.getByText('Hold Control Left to talk · Global', { exact: true }).waitFor();
  const enabled = () => page.evaluate(() => window.pttEngine?.getLocalTracks().get('microphone')?.enabled);
  await until(enabled, false, 'silent native join');
  const capture = () => page.evaluate(() => {
    const input = window.pttEngine.getMicrophoneInput();
    return { id: input?.id, readyState: input?.readyState, enabled: input?.enabled };
  });
  const initialCapture = await capture();
  assert.equal(initialCapture.readyState, 'live'); assert.equal(initialCapture.enabled, true);
  const muteButton = page.getByRole('button', { name: 'Mute microphone', exact: true });
  assert.ok(!(await muteButton.getAttribute('class')).includes('danger'), 'PTT waiting is not manual mute');
  assert.equal((await input('focus')).foreground, true, 'External test window must have OS focus');
  assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_focused', { label: 'main' })), false, 'Keyboard acceptance uses real background focus');
  const before = await input('snapshot');
  await input('keyDown', { scan: 0x1d }); await until(enabled, true, 'background key down');
  await input('keyUp', { scan: 0x1d }); await until(enabled, false, 'background key up');
  assert.ok((await input('snapshot')).keys > before.keys, 'The other application must still receive the shortcut');
  console.log('PASS native background keyboard, release and input passthrough');
  await input('focus');
  await input('focusNative');
  await muteButton.click();
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  assert.equal(await muteButton.evaluate(element => element === document.activeElement), true, 'Mute button retains keyboard focus');
  await input('keyDown', { scan: 0x1d, target: 'native' });
  await until(enabled, true, 'foreground Left Ctrl after unmute');
  assert.ok(!(await muteButton.getAttribute('class')).includes('danger'));
  await input('keyUp', { scan: 0x1d }); await until(enabled, false, 'foreground Left Ctrl release');
  assert.deepEqual(await capture(), initialCapture, 'PTT must keep the microphone capture alive');
  console.log('PASS native Left Ctrl with focused mute button, independent mute state and continuous capture');
  await input('focus');

  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|minimize', { label: 'main' }));
  await input('focus');
  await input('keyDown', { scan: 0x1d }); await until(enabled, true, 'minimized key down');
  await pause(1600); assert.equal(await enabled(), true, 'Heartbeat stays alive while minimized');
  await input('keyUp', { scan: 0x1d }); await until(enabled, false, 'minimized key up');
  await input('restoreNative');
  console.log('PASS native minimized push-to-talk and heartbeat');

  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await input('focus'); await input('keyDown', { scan: 0x1d }); await pause(200);
  assert.equal(await enabled(), false, 'Manual mute overrides the global shortcut');
  await input('keyUp', { scan: 0x1d });
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await page.getByRole('button', { name: 'Deafen call', exact: true }).click();
  await input('focus'); await input('keyDown', { scan: 0x1d }); await pause(200);
  assert.equal(await enabled(), false, 'Deafen overrides the global shortcut');
  await input('keyUp', { scan: 0x1d });
  await page.getByRole('button', { name: 'Undeafen call', exact: true }).click();

  await page.getByRole('button', { name: 'Audio and video settings' }).click();
  const bind = page.getByRole('button', { name: 'Set push-to-talk shortcut' });
  await bind.click();
  // Configure through the existing UI handler; actual background presses below use Windows SendInput.
  await bind.dispatchEvent('mousedown', { button: 3, buttons: 8 });
  await bind.dispatchEvent('mouseup', { button: 3, buttons: 0 });
  await page.getByRole('button', { name: 'Back to call' }).click();
  await page.getByText('Hold Mouse back to talk · Global', { exact: true }).waitFor();
  await input('focus');
  assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_focused', { label: 'main' })), false, 'Mouse acceptance uses real background focus');
  await input('mouseDown', { button: 3 }); await until(enabled, true, 'background side button down');
  await input('mouseUp', { button: 3 }); await until(enabled, false, 'background side button up');
  console.log('PASS native mouse rebinding, mute and deafen');

  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|minimize', { label: 'main' }));
  await input('focus');
  await input('mouseDown', { button: 3 }); await until(enabled, true, 'minimized mouse down');
  await input('mouseUp', { button: 3 }); await until(enabled, false, 'minimized mouse up');
  await input('restoreNative');
  for (const button of [0, 1, 2, 4, 3]) {
    await page.getByRole('button', { name: 'Audio and video settings' }).click();
    const shortcut = page.getByRole('button', { name: 'Set push-to-talk shortcut' });
    await shortcut.click();
    if (button === 0) await shortcut.click();
    else {
      await shortcut.dispatchEvent('mousedown', { button });
      await shortcut.dispatchEvent('mouseup', { button });
    }
    await page.getByRole('button', { name: 'Back to call' }).click();
    const label = ['left', 'middle', 'right', 'back', 'forward'][button];
    await page.getByText(`Hold Mouse ${label} to talk · Global`, { exact: true }).waitFor();
    await input('focus');
    const beforeMouse = await input('snapshot');
    await input('mouseDown', { button }); await until(enabled, true, `background ${label} mouse down`);
    await input('mouseUp', { button }); await until(enabled, false, `background ${label} mouse up`);
    await until(() => input('snapshot'), value => value.mouse > beforeMouse.mouse, `${label} mouse passthrough`);
  }
  console.log('PASS all five mouse buttons, passthrough and minimized mouse input');

  await page.getByRole('button', { name: 'Leave call' }).click();
  assert.equal(await page.evaluate(() => window.pttEngine.getLocalTracks().size), 0);
  await input('mouseDown', { button: 3 });
  await page.getByRole('button', { name: 'Join call', exact: true }).click();
  await page.getByText('Hold Mouse back to talk · Global', { exact: true }).waitFor();
  assert.equal(await enabled(), false, 'Already-held input cannot open a new call');
  await input('mouseUp', { button: 3 }); await input('focus');
  await input('mouseDown', { button: 3 }); await until(enabled, true, 'fresh hold after rejoin');
  await input('mouseUp', { button: 3 }); await until(enabled, false, 'release after rejoin');
  await page.getByRole('button', { name: 'Leave call' }).click();
  console.log('PASS native leave, rejoin and already-held input');

  // Exercise the actual native lease with no frontend heartbeat.
  await page.evaluate(async () => {
    const loaded = performance.getEntriesByType('resource').find(entry => /(@tauri-apps_api_event|@tauri-apps\/api\/event)/.test(entry.name));
    const { listen } = await import(loaded.name);
    window.pttLeaseEvents = [];
    window.pttLeaseUnlisten = await listen('bc-global-push-to-talk', event => window.pttLeaseEvents.push(event.payload));
    window.pttLease = await window.__TAURI_INTERNALS__.invoke('push_to_talk_start', { binding: { kind: 'keyboard', code: 'ControlLeft' } });
  });
  await input('focus'); await input('keyDown', { scan: 0x1d });
  await until(() => page.evaluate(() => window.pttLeaseEvents.some(event => event.pressed)), true, 'native lease held');
  await until(() => page.evaluate(() => window.pttLeaseEvents.some(event => !event.healthy && !event.pressed)), true, 'native lease expiry', 8000);
  await input('keyUp', { scan: 0x1d });
  const expired = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('push_to_talk_heartbeat', { sessionId: window.pttLease.sessionId }));
  assert.equal(expired.healthy, false);
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke('push_to_talk_stop', { sessionId: window.pttLease.sessionId });
    window.pttLeaseUnlisten(); await window.pttSource.close();
  });
  console.log('PASS native watchdog expires and releases a held shortcut');
  }

  external = createServer((_request, response) => response.end('<html><body>Untrusted local test origin</body></html>'));
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  await page.goto(`http://127.0.0.1:${external.address().port}`);
  const rejected = await page.evaluate(async () => {
    try {
      if (!window.__TAURI_INTERNALS__?.invoke) return true;
      await window.__TAURI_INTERNALS__.invoke('push_to_talk_start', { binding: { kind: 'keyboard', code: 'ControlLeft' } });
      return false;
    } catch { return true; }
  });
  assert.equal(rejected, true, 'Untrusted origins cannot start global input');
  await page.goto(origin);
  await page.screenshot({ path: '.local/native-ptt-acceptance.png' });
  console.log(lifecycleOnly ? 'PASS native origin boundary; lifecycle checks passed. Background input acceptance remains separate.' : 'PASS native origin boundary; all global push-to-talk acceptance checks passed');
} finally {
  await page.getByRole('button', { name: 'Leave call', exact: true }).click({ timeout: 1000 }).catch(() => {});
  await page.evaluate(async () => {
    if (window.pttLease) await window.__TAURI_INTERNALS__.invoke('push_to_talk_stop', { sessionId: window.pttLease.sessionId }).catch(() => {});
    window.pttLeaseUnlisten?.(); await window.pttSource?.close().catch(() => {});
  }).catch(() => {});
  if (fixture) {
    await input('keyUp', { scan: 0x1d }).catch(() => {});
    await input('mouseUp', { button: 3 }).catch(() => {});
    await input('close').catch(() => {});
    fixture.kill();
  }
  external?.close();
  await browser.close();
}
