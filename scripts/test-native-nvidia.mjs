// Opt-in hardware integration check. Connect only to a temporary local WebView2
// debugging endpoint; never enable remote debugging in a distributed build.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';

const endpoint = process.env.BETTERCOMMS_NATIVE_CDP ?? 'http://127.0.0.1:9223';
const url = new URL(endpoint);
assert.equal(
  url.hostname,
  '127.0.0.1',
  'Native debugging must stay on loopback',
);

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => new URL(candidate.url()).port === '5173');
  assert.ok(page, 'Start the native development preview before this check');
  await page.bringToFront();

  const transport = await page.evaluate(async () => {
    const { createNvidiaDenoiser } =
      await import('/src/media/nvidiaDenoise.ts');
    const invoke = (command, args) =>
      window.__TAURI_INTERNALS__.invoke(command, args);
    const status = await invoke('nvidia_status');
    if (!status.ready) throw new Error(status.detail);
    const input = new AudioContext({ sampleRate: 48_000 });
    const oscillator = new OscillatorNode(input, { frequency: 440 });
    const gain = new GainNode(input, { gain: 0.1 });
    const source = input.createMediaStreamDestination();
    oscillator.connect(gain).connect(source);
    oscillator.start();
    await input.resume();
    const raw = source.stream.getAudioTracks()[0];
    let processed;
    let streamSession;
    let failure;
    try {
      processed = await createNvidiaDenoiser(raw, async (command, args) => {
        const answer = await invoke(command, args);
        if (command === 'nvidia_stream_start') streamSession = answer;
        return answer;
      });
      void processed.failure?.then((error) => {
        failure = String(error);
      });

      const output = new AudioContext({ sampleRate: 48_000 });
      const analyser = output.createAnalyser();
      analyser.fftSize = 256;
      const decoded = output.createMediaStreamSource(
        new MediaStream([processed.track]),
      );
      decoded.connect(analyser);
      await output.resume();
      const samples = new Float32Array(analyser.fftSize);
      let decodedBlocks = 0;
      let nonFiniteSamples = 0;
      let framesAdvancedAcrossStalls = true;
      let previousFrames = 0;
      const deadline = performance.now() + 30_000;
      let nextStall = performance.now() + 1_000;
      while (performance.now() < deadline) {
        analyser.getFloatTimeDomainData(samples);
        nonFiniteSamples += samples.reduce(
          (count, sample) => count + (Number.isFinite(sample) ? 0 : 1),
          0,
        );
        decodedBlocks++;
        if (performance.now() >= nextStall) {
          const before = processed.diagnostics.processedFrames;
          const stress = document.createElement('div');
          stress.style.cssText =
            'position:fixed;inset:0;contain:strict;display:grid;grid-template-columns:repeat(40,1fr)';
          stress.replaceChildren(
            ...Array.from({ length: 400 }, (_, index) => {
              const cell = document.createElement('span');
              cell.textContent = String(index);
              return cell;
            }),
          );
          document.body.append(stress);
          void stress.offsetHeight;
          const stallUntil = performance.now() + 350;
          while (performance.now() < stallUntil) void stress.offsetWidth;
          stress.remove();
          await new Promise((resolve) => setTimeout(resolve, 150));
          const after = processed.diagnostics.processedFrames;
          framesAdvancedAcrossStalls &&= after > before;
          previousFrames = after;
          nextStall = performance.now() + 1_000;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const outputBefore = processed.track.readyState;
      const framesBeforeDispose = processed.diagnostics.processedFrames;
      processed.dispose();
      processed.dispose();
      await new Promise((resolve) => setTimeout(resolve, 250));
      decoded.disconnect();
      await output.close();
      return {
        gpuFramesProcessed: framesBeforeDispose > 100,
        diagnosticsUpdated: previousFrames > 0,
        framesAdvancedAcrossStalls,
        decodedAudioFinite: decodedBlocks > 100 && nonFiniteSamples === 0,
        outputBefore,
        outputAfter: processed.track.readyState,
        rawAfter: raw.readyState,
        failure: failure ?? null,
        port: streamSession.port,
      };
    } finally {
      processed?.dispose();
      raw.stop();
      oscillator.stop();
      await input.close();
    }
  });
  const { port, ...audioResult } = transport;
  const endpointRefused = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(5_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Native endpoint closure probe timed out'));
    });
  });
  assert.deepEqual(
    { ...audioResult, endpointRefused },
    {
      gpuFramesProcessed: true,
      diagnosticsUpdated: true,
      framesAdvancedAcrossStalls: true,
      decodedAudioFinite: true,
      outputBefore: 'live',
      outputAfter: 'ended',
      rawAfter: 'live',
      failure: null,
      endpointRefused: true,
    },
  );
  console.log(
    'PASS: native WebView audio worklet -> loopback worker -> NVIDIA GPU stays live through renderer stalls; decoded output, diagnostics, and cleanup verified.',
  );

  const forcedFailure = await page.evaluate(async () => {
    const { createNvidiaDenoiser } =
      await import('/src/media/nvidiaDenoise.ts');
    const invoke = (command, args) =>
      window.__TAURI_INTERNALS__.invoke(command, args);
    const input = new AudioContext({ sampleRate: 48_000 });
    const oscillator = new OscillatorNode(input, { frequency: 440 });
    const destination = input.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    await input.resume();
    const raw = destination.stream.getAudioTracks()[0];
    let processed;
    let sessionId;
    try {
      processed = await createNvidiaDenoiser(raw, async (command, args) => {
        const answer = await invoke(command, args);
        if (command === 'nvidia_stream_start') sessionId = answer.sessionId;
        return answer;
      });
      const deadline = Date.now() + 5_000;
      while (
        processed.diagnostics.processedFrames === 0 &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      await invoke('nvidia_stream_stop', { sessionId });
      const failure = await Promise.race([
        processed.failure.then((error) => String(error)),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('forced stream stop was not reported')),
            5_000,
          ),
        ),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        started: processed.diagnostics.processedFrames > 0,
        failureReported: failure.length > 0,
        outputEnded: processed.track.readyState === 'ended',
        rawLive: raw.readyState === 'live',
      };
    } finally {
      processed?.dispose();
      raw.stop();
      oscillator.stop();
      await input.close();
    }
  });
  assert.deepEqual(forcedFailure, {
    started: true,
    failureReported: true,
    outputEnded: true,
    rawLive: true,
  });
  console.log(
    'PASS: forced native stream termination reaches the denoiser failure contract.',
  );

  const engineResult = await page.evaluate(async () => {
    const { MediaEngine } = await import('/src/media/engine.ts');
    const input = new AudioContext({ sampleRate: 48_000 });
    const oscillator = new OscillatorNode(input, { frequency: 440 });
    const gain = new GainNode(input, { gain: 0.1 });
    const destination = input.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await input.resume();
    const raw = destination.stream.getAudioTracks()[0];
    const capture = navigator.mediaDevices.getUserMedia;
    const owned = [];
    const notices = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const clone = raw.clone();
      owned.push(clone);
      return new MediaStream([clone]);
    };
    const engine = new MediaEngine({
      signaling: { localPeerId: 'native-validation', send() {} },
    });
    engine.addEventListener('denoiser-status', (event) =>
      notices.push(event.detail),
    );
    try {
      await engine.captureUserMedia({ camera: false, denoiser: 'nvidia' });
      engine.getLocalTracks().get('microphone').enabled = false;
      await engine.captureUserMedia({ camera: false, denoiser: 'nvidia' });
      const microphone = engine.getLocalTracks().get('microphone');
      const stallUntil = performance.now() + 350;
      while (performance.now() < stallUntil) {
        /* deliberate renderer stall */
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const result = {
        replacementMuted: microphone?.enabled === false,
        noFallbackReported: !notices.some(
          (notice) => notice.active === 'rnnoise',
        ),
        microphoneLive: microphone?.readyState === 'live',
        microphoneMuted: microphone?.enabled === false,
      };
      engine.dispose();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        ...result,
        microphoneEnded: microphone?.readyState === 'ended',
        rawClonesReleased: owned.every((track) => track.readyState === 'ended'),
      };
    } finally {
      engine.dispose();
      navigator.mediaDevices.getUserMedia = capture;
      raw.stop();
      oscillator.stop();
      await input.close();
    }
  });
  assert.deepEqual(engineResult, {
    replacementMuted: true,
    noFallbackReported: true,
    microphoneLive: true,
    microphoneMuted: true,
    microphoneEnded: true,
    rawClonesReleased: true,
  });
  console.log(
    'PASS: native microphone recapture preserves mute, renderer stalls do not trigger fallback, and engine cleanup releases every track.',
  );
} finally {
  await browser.close(); // Disconnect CDP; the native application remains open.
}
