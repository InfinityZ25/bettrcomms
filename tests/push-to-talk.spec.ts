import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;
async function json(response: APIResponse) {
  expect(response.ok(), `API status ${response.status()}`).toBeTruthy();
  return response.json();
}
async function login(context: BrowserContext, name: string, suffix: string) {
  let response: APIResponse;
  const deadline = Date.now() + 65_000;
  do {
    response = await context.request.post('/api/v1/auth/dev', { headers: { Origin: origin }, data: { name, email: `${name}-${suffix}@example.test` } });
    if (response.status() !== 429 || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  } while (true);
  const value = await json(response);
  return value.user ?? value;
}

async function settings(page: Page) {
  await page.getByRole('button', { name: 'Audio and video settings' }).click();
  await expect(page.getByRole('checkbox', { name: 'Push-to-talk', exact: true })).toBeVisible();
}

test('side mouse buttons can be assigned and held without navigating browser history', async ({ page, context }) => {
  await page.goto('/');
  await settings(page);
  await page.getByRole('checkbox', { name: 'Push-to-talk', exact: true }).check();
  const cdp = await context.newCDPSession(page);
  const bind = page.getByRole('button', { name: 'Set push-to-talk shortcut' });
  for (const [button, buttons, label] of [['back', 8, 'Mouse back'], ['forward', 16, 'Mouse forward']] as const) {
    await bind.click();
    const control = (await bind.boundingBox())!;
    const at = { x: control.x + control.width / 2, y: control.y + control.height / 2, button, clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0 });
    await expect(bind).toHaveText(`Shortcut: ${label}`);
    await page.evaluate(async () => {
      const { CallMicrophone } = await import('/src/media/pushToTalk.ts');
      const input = new CallMicrophone(enabled => { (window as any).sideMouseEnabled = enabled; });
      (window as any).stopSideMouse = input.subscribe(() => {});
      input.start();
    });
    const heading = (await page.getByRole('heading', { name: 'Settings', exact: true }).boundingBox())!;
    const target = { ...at, x: heading.x + 10, y: heading.y + 10 };
    const url = page.url();
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...target, buttons });
    await expect.poll(() => page.evaluate(() => (window as any).sideMouseEnabled)).toBe(true);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, buttons: 0 });
    await expect.poll(() => page.evaluate(() => (window as any).sideMouseEnabled)).toBe(false);
    await expect(page).toHaveURL(url);
    await page.evaluate(() => (window as any).stopSideMouse());
  }
  await cdp.detach();
});

test('push-to-talk is opt-in and remembers keyboard and mouse shortcuts in Settings', async ({ page }) => {
  await page.goto('/');
  await settings(page);
  const toggle = page.getByRole('checkbox', { name: 'Push-to-talk', exact: true });
  const bind = page.getByRole('button', { name: 'Set push-to-talk shortcut' });
  await expect(toggle).not.toBeChecked();
  await expect(bind).toBeDisabled();
  await toggle.check();
  await bind.click(); await page.keyboard.press('v');
  await expect(bind).toHaveText('Shortcut: V');
  await bind.click(); await page.keyboard.press('Escape');
  await expect(bind).toHaveText('Shortcut: V');
  for (const [button, label] of [['middle', 'Mouse middle'], ['right', 'Mouse right'], ['left', 'Mouse left']] as const) {
    await bind.click(); await bind.click({ button });
    await expect(bind).toHaveText(`Shortcut: ${label}`);
  }
  await bind.click(); await page.keyboard.press('v');
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(bind).toHaveText('Shortcut: V');
  await page.screenshot({ path: 'test-results/push-to-talk-settings-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/push-to-talk-settings-mobile.png', fullPage: true });
  await toggle.uncheck(); await page.reload();
  await expect(toggle).not.toBeChecked();
});

for (const route of ['automatic', 'relay']) {
  test(`push-to-talk gates received ${route} audio and preserves mute across settings and rejoin`, async ({ browser }) => {
    test.setTimeout(180_000);
    const a = await browser.newContext({ baseURL });
    const b = await browser.newContext({ baseURL });
    try {
      const suffix = `${Date.now()}-${route}`;
      await login(a, 'PTTSender', suffix);
      const guest = await login(b, 'PTTReceiver', suffix);
      const request = await json(await a.request.post('/api/v1/friends/requests', { headers: { Origin: origin }, data: { user_id: guest.id } }));
      await json(await b.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, { headers: { Origin: origin }, data: {} }));
      const name = `PTT ${suffix}`;
      const { room } = await json(await a.request.post('/api/v1/rooms', { headers: { Origin: origin }, data: { name } }));
      await json(await a.request.post(`/api/v1/rooms/${room.id}/members`, { headers: { Origin: origin }, data: { user_id: guest.id } }));
      const sender = await a.newPage(); const receiver = await b.newPage();
      for (const page of [sender, receiver]) {
        await page.goto('/');
        // Observe the real call engine without adding production-only test hooks.
        await page.evaluate(async route => {
          localStorage.setItem('bc-voice-route', route);
          const loaded = performance.getEntriesByType('resource').find(entry => /\/src\/media\/engine\.ts(?:\?|$)/.test(entry.name));
          if (!loaded) throw new Error('Call engine module was not loaded');
          const { MediaEngine } = await import(loaded.name);
          const original = MediaEngine.prototype.setMicrophoneEnabled;
          MediaEngine.prototype.setMicrophoneEnabled = function (enabled: boolean) {
            (window as any).pttEngine = this;
            original.call(this, enabled);
          };
        }, route);
        await page.getByRole('button', { name, exact: true }).click();
      }
      await sender.evaluate(async () => {
        // A steady source avoids acoustic echo cancellation of Chromium's shared fake device.
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const destination = context.createMediaStreamDestination();
        oscillator.frequency.value = 440; gain.gain.value = 0.1;
        oscillator.connect(gain).connect(destination); oscillator.start();
        await context.resume();
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => constraints?.audio && !constraints.video
          ? new MediaStream([destination.stream.getAudioTracks()[0].clone()]) : original(constraints);
        (window as any).pttSource = context;
      });
      await settings(sender);
      await sender.getByRole('checkbox', { name: 'Push-to-talk', exact: true }).check();
      await sender.getByRole('button', { name: 'Set push-to-talk shortcut' }).click();
      await sender.keyboard.press('v');
      await sender.getByRole('button', { name: 'Back to call' }).click();
      await sender.getByRole('button', { name: 'Join call', exact: true }).click();
      await receiver.getByRole('button', { name: 'Join call', exact: true }).click();
      await expect(sender.getByRole('button', { name: 'Leave call' })).toBeVisible();
      const micEnabled = () => sender.evaluate(() => (window as any).pttEngine.getLocalTracks().get('microphone')?.enabled);
      await expect.poll(micEnabled).toBe(false);
      await expect.poll(() => receiver.evaluate(() => (window as any).pttEngine.getRemoteTracks().filter((t: any) => t.source === 'microphone').length)).toBe(1);
      if (route === 'relay') {
        await expect.poll(() => receiver.evaluate(async () => {
          const e = (window as any).pttEngine;
          const peer = e.getRemoteTracks()[0].peerId;
          return (await e.getStats(peer)).voiceRelay?.state;
        })).toBe('relayed');
      }
      await receiver.evaluate(async () => {
        const e = (window as any).pttEngine;
        const context = new AudioContext();
        const source = context.createMediaStreamSource(new MediaStream([e.getRemoteTracks().find((t: any) => t.source === 'microphone').track]));
        const analyser = context.createAnalyser();
        source.connect(analyser); await context.resume();
        (window as any).pttMeter = { context, source, analyser };
      });
      const rms = () => receiver.evaluate(() => {
        const analyser = (window as any).pttMeter.analyser;
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      });
      await sender.locator('.self .avatar-large, .camera-tile.self').first().click();
      await sender.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      await sender.keyboard.down('v');
      await expect.poll(micEnabled).toBe(true);
      await expect.poll(rms).toBeGreaterThan(0.005);
      await sender.keyboard.up('v');

      await sender.getByRole('button', { name: 'Toggle chat' }).click();
      const composer = sender.getByRole('textbox', { name: 'Message your room' });
      await composer.fill('v');
      await composer.press('v');
      await expect.poll(micEnabled).toBe(false);
      await composer.fill('');
      await sender.getByRole('button', { name: 'Close chat' }).click();
      await expect.poll(micEnabled).toBe(false);
      await expect.poll(rms).toBeLessThan(0.001);
      await sender.keyboard.down('v');
      await sender.evaluate(() => window.dispatchEvent(new Event('blur')));
      await expect.poll(micEnabled).toBe(false);
      await sender.keyboard.up('v');

      await sender.getByRole('button', { name: 'Mute microphone', exact: true }).click();
      await sender.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      await sender.keyboard.down('v'); await expect.poll(micEnabled).toBe(false); await sender.keyboard.up('v');
      await sender.getByRole('button', { name: 'Deafen call', exact: true }).click();
      await sender.getByRole('button', { name: 'Undeafen call', exact: true }).click();
      await expect(sender.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeVisible();
      await sender.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
      await expect.poll(micEnabled).toBe(false);

      await settings(sender);
      const bind = sender.getByRole('button', { name: 'Set push-to-talk shortcut' });
      await bind.click(); await bind.click({ button: 'middle' });
      await sender.getByRole('button', { name: 'Back to call' }).click();
      const tile = sender.locator('.camera-tile.self');
      await tile.hover(); await sender.mouse.down({ button: 'middle' });
      await expect.poll(micEnabled).toBe(true);
      await sender.mouse.up({ button: 'middle' }); await expect.poll(micEnabled).toBe(false);
      // Replacement after a pending device request must use the latest gate.
      await sender.evaluate(async () => {
        const e = (window as any).pttEngine;
        const pending = e.captureUserMedia({ microphone: true, camera: false });
        e.setMicrophoneEnabled(false);
        await pending;
      });
      await expect.poll(micEnabled).toBe(false);

      await sender.getByRole('button', { name: 'Leave call' }).click();
      await sender.getByRole('button', { name: 'Join call', exact: true }).click();
      await expect(sender.getByRole('button', { name: 'Leave call' })).toBeVisible();
      await expect.poll(micEnabled).toBe(false);
      await settings(sender);
      await sender.getByRole('checkbox', { name: 'Push-to-talk', exact: true }).uncheck();
      await expect.poll(micEnabled).toBe(true);
      await sender.getByRole('button', { name: 'Back to call' }).click();
      await sender.getByRole('button', { name: 'Leave call' }).click();
      await receiver.getByRole('button', { name: 'Leave call' }).click();
      await receiver.evaluate(() => (window as any).pttMeter.context.close());
      await sender.evaluate(() => (window as any).pttSource.close());
    } finally { await a.close(); await b.close(); }
  });
}

test('microphone release gates pending sender replacement without muting other sources', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { MediaEngine } = await import('/src/media/engine.ts');
    const engine = new MediaEngine({ signaling: { localPeerId: 'gate-test', send() {} } });
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const microphone = destination.stream.getAudioTracks()[0].clone();
    const replacement = microphone.clone();
    const system = microphone.clone();
    const canvas = document.createElement('canvas');
    const camera = canvas.captureStream(5).getVideoTracks()[0];
    try {
      engine.setMicrophoneEnabled(false);
      await engine.setLocalTrack('microphone', microphone);
      const startsSilent = !microphone.enabled;
      await engine.setLocalTrack('system', system);
      await engine.setLocalTrack('camera', camera);
      engine.addPeer('replacement-peer');
      const sender = (engine as any).peers.get('replacement-peer').senders.get('microphone') as RTCRtpSender;
      const replace = sender.replaceTrack.bind(sender);
      let resume!: () => void;
      let waiting!: () => void;
      const entered = new Promise<void>(resolve => { waiting = resolve; });
      sender.replaceTrack = async track => {
        await replace(track);
        waiting();
        await new Promise<void>(resolve => { resume = resolve; });
      };
      engine.setMicrophoneEnabled(true);
      const pending = engine.setLocalTrack('microphone', replacement);
      await entered;
      engine.setMicrophoneEnabled(false);
      const bothSilent = !microphone.enabled && !replacement.enabled;
      resume(); await pending;
      const retainedSilence = !engine.getLocalTracks().get('microphone')!.enabled;
      const independent = system.enabled && camera.enabled;
      engine.dispose();
      return { startsSilent, bothSilent, retainedSilence, independent, stopped: [microphone, replacement, system, camera].every(track => track.readyState === 'ended') };
    } finally {
      engine.dispose();
      destination.stream.getTracks().forEach(track => track.stop());
      await context.close();
    }
  });
  expect(result).toEqual({ startsSilent: true, bothSilent: true, retainedSilence: true, independent: true, stopped: true });
});
