import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const port = Number(process.argv[2] ?? 9224);
const local = process.env.LOCALAPPDATA;
if (!local) throw new Error('LOCALAPPDATA is unavailable');
const packageRoot = path.join(local, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe');
const packageNames = (await readdir(packageRoot)).sort();
const ffplay = path.join(packageRoot, packageNames.at(-1), 'bin', 'ffplay.exe');
const external = spawn(ffplay, ['-nodisp', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-af', 'volume=0.2'], {
  stdio: 'ignore', windowsHide: true,
});
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => /^http:\/\/(?:127\.0\.0\.1|localhost):5173\//.test(candidate.url()));
  if (!page) throw new Error('BetterComms WebView page was not found');
  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48_000 });
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 770;
    gain.gain.value = 0.2;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    await context.resume();
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error('Tauri invoke bridge is unavailable');
    const session = await invoke('native_system_audio_start', { excludeCallAudio: true });
    const samples = [];
    const deadline = performance.now() + 1_500;
    try {
      while (performance.now() < deadline) {
        const value = await invoke('native_system_audio_read', { sessionId: session.sessionId });
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
        const floats = new Float32Array(bytes.slice().buffer);
        for (const sample of floats) samples.push(sample);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await invoke('native_system_audio_stop', { sessionId: session.sessionId });
      oscillator.stop();
      await context.close();
    }
    function magnitude(frequency) {
      let real = 0, imaginary = 0, frames = 0;
      const omega = Math.PI * 2 * frequency / 48_000;
      for (let index = 0; index + 1 < samples.length; index += 2) {
        const phase = omega * frames++;
        real += samples[index] * Math.cos(phase);
        imaginary -= samples[index] * Math.sin(phase);
      }
      return frames ? Math.hypot(real, imaginary) * 2 / frames : 0;
    }
    return { mode: session.mode, frames: samples.length / 2, external660: magnitude(660), webview770: magnitude(770) };
  });
  console.log(JSON.stringify(result));
  assert.ok(result.frames > 10_000, 'Native capture must return enough stereo frames');
  assert.ok(result.external660 > 0.001, 'External application audio must be retained');
  assert.ok(result.webview770 < result.external660 * 0.05, 'WebView call playback must be excluded');
} finally {
  external.kill();
  await browser?.close();
}
