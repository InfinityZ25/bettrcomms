// Opt-in packaged desktop smoke. The caller launches the release executable with
// an isolated WebView2 profile and loopback CDP port before running this script.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const endpoint = process.env.BETTERCOMMS_RELEASE_CDP ?? 'http://127.0.0.1:9224';
const expectedOrigin = process.env.BETTERCOMMS_RELEASE_ORIGIN
  ?? 'https://bettrcomms-production.up.railway.app';
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = await (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const candidate = browser.contexts().flatMap(context => context.pages())[0];
      if (candidate && candidate.url().startsWith(expectedOrigin)) return candidate;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Packaged hosted page did not appear');
  })();
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error')
      consoleErrors.push(message.text().replace(/https?:\/\/[^\s?#]+[^\s]*/g, '[redacted-url]'));
  });
  await page.waitForLoadState('domcontentloaded');
  assert.equal(new URL(page.url()).origin, expectedOrigin);
  await page.getByRole('button', { name: /Continue with WorkOS/i }).waitFor({ timeout: 20_000 });
  const result = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error('Tauri IPC bridge is missing');
    const [boot, screen, media, ffmpeg, applicationAudio] = await Promise.all([
      invoke('desktop_boot_config'),
      invoke('native_screen_capabilities'),
      invoke('desktop_media_capabilities'),
      invoke('ffmpeg_install_info'),
      invoke('native_system_audio_capabilities'),
    ]);
    // No page click, fake permission, or test autoplay flag may unlock this context.
    const playback = new AudioContext();
    const autoplayState = await Promise.race([
      playback.resume().then(() => playback.state),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 2000)),
    ]);
    await playback.close();
    return {
      boot,
      autoplayState,
      ffmpeg: { supported: ffmpeg.supported, installed: ffmpeg.installed },
      screen: { available: screen.available, version: screen.version },
      media,
      applicationAudio,
      mediaDevices: Boolean(navigator.mediaDevices),
      voiceCodec: {
        processor: typeof MediaStreamTrackProcessor === 'function',
        encoder: typeof AudioEncoder === 'function' && (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 })).supported,
        decoder: typeof AudioDecoder === 'function' && (await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 })).supported,
      },
    };
  });
  assert.equal(result.boot.apiOrigin, expectedOrigin);
  assert.equal(result.boot.schemaVersion, 1);
  assert.equal(result.screen.version, 1);
  assert.equal(result.applicationAudio.applicationAudio, result.applicationAudio.available);
  assert.equal(result.media.platform, 'windows');
  assert.equal(result.mediaDevices, true);
  assert.equal(result.autoplayState, 'running');
  assert.equal(result.ffmpeg.supported, true);
  assert.deepEqual(result.voiceCodec, { processor: true, encoder: true, decoder: true });

  const nvidiaBridge = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const status = await invoke('nvidia_status');
    if (!status.ready) return { skipped: true, detail: status.detail };
    let session;
    let socket;
    try {
      session = await invoke('nvidia_stream_start', {});
      if (session.sampleRate !== 48_000 || ![480, 512, 960].includes(session.frameSamples))
        throw new Error('NVIDIA stream returned an unsupported frame format');
      const reply = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('NVIDIA hosted loopback bridge timed out')), 8_000);
        socket = new WebSocket(`ws://127.0.0.1:${session.port}/`);
        socket.binaryType = 'arraybuffer';
        let authenticated = false;
        let processedFrames = 0;
        socket.onerror = () => reject(new Error('NVIDIA hosted loopback WebSocket failed'));
        socket.onclose = () => {
          if (!authenticated) reject(new Error('NVIDIA hosted loopback WebSocket closed during authentication'));
        };
        socket.onopen = () => socket.send(JSON.stringify({ token: session.token }));
        socket.onmessage = event => {
          if (!authenticated) {
            if (typeof event.data !== 'string' || JSON.parse(event.data).type !== 'ready') {
              clearTimeout(timeout);
              reject(new Error('NVIDIA hosted loopback authentication was rejected'));
              return;
            }
            authenticated = true;
            socket.send(new Float32Array(session.frameSamples).buffer);
            return;
          }
          if (!(event.data instanceof ArrayBuffer)) return;
          if (event.data.byteLength !== session.frameSamples * Float32Array.BYTES_PER_ELEMENT) {
            clearTimeout(timeout);
            reject(new Error('NVIDIA hosted loopback returned an invalid binary frame'));
            return;
          }
          processedFrames += 1;
          if (processedFrames < 3) {
            socket.send(new Float32Array(session.frameSamples).buffer);
            return;
          }
          clearTimeout(timeout);
          resolve({ bytes: event.data.byteLength, processedFrames });
        };
      });
      return {
        skipped: false,
        frameSamples: session.frameSamples,
        replyBytes: reply.bytes,
        processedFrames: reply.processedFrames,
      };
    } finally {
      socket?.close();
      if (session) await invoke('nvidia_stream_stop', { sessionId: session.sessionId }).catch(() => undefined);
    }
  });

  await page.getByRole('button', { name: /Continue with WorkOS/i }).click();
  await page.waitForURL(url => url.origin !== expectedOrigin, { timeout: 20_000 });
  const authHost = new URL(page.url()).hostname;
  assert.ok(authHost === 'api.workos.com' || authHost.endsWith('.authkit.app'),
    `Unexpected authentication host: ${authHost}`);
  const rejection = await page.evaluate(async () => {
    if (!window.__TAURI_INTERNALS__?.invoke) return 'bridge-not-exposed';
    try {
      await window.__TAURI_INTERNALS__.invoke('desktop_media_capabilities');
      return 'unexpected-success';
    } catch (error) {
      return String(error);
    }
  });
  assert.notEqual(rejection, 'unexpected-success', 'External authentication pages must not invoke native commands');
  console.log('PASS packaged hosted desktop', JSON.stringify({
    origin: expectedOrigin,
    nativeScreenAvailable: result.screen.available,
    autoplayState: result.autoplayState,
    ffmpeg: result.ffmpeg,
    mediaDevices: result.mediaDevices,
    authHost,
    externalIpc: rejection === 'bridge-not-exposed' ? rejection : 'rejected',
    nvidiaBridge,
    consoleErrorCount: consoleErrors.length,
    consoleErrors: consoleErrors.slice(0, 5),
  }));
} finally {
  await browser.close();
}
