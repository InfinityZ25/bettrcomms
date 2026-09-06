// Opt-in hardware integration check. Connect only to a temporary local WebView2
// debugging endpoint; never enable remote debugging in a distributed build.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const endpoint = process.env.BETTERCOMMS_NATIVE_CDP ?? 'http://127.0.0.1:9223';
const endpointUrl = new URL(endpoint);
assert.equal(
  endpointUrl.hostname,
  '127.0.0.1',
  'Native debugging must stay on loopback',
);

const workerPattern = '**/src/media/nvidiaDenoise.worker.ts*';
const delayedWorkerPrelude = String.raw`
const BettercommsNativeWebSocket = globalThis.WebSocket;
let bettercommsBinaryResponses = 0;
globalThis.WebSocket = class BettercommsDelayedWebSocket extends BettercommsNativeWebSocket {
  set onmessage(listener) {
    super.onmessage = listener && ((event) => {
      const shouldDelay = event.data instanceof ArrayBuffer &&
        ++bettercommsBinaryResponses === 200;
      if (shouldDelay) setTimeout(() => listener.call(this, event), 120);
      else listener.call(this, event);
    });
  }
};
`;

const browser = await chromium.connectOverCDP(endpoint);
let page;
let routeInstalled = false;
const delayWorkerResponse = async (route) => {
  const response = await route.fetch();
  await route.fulfill({
    response,
    body: `${delayedWorkerPrelude}\n${await response.text()}`,
  });
};

try {
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => new URL(candidate.url()).port === '5173');
  assert.ok(page, 'Start the native development preview before this check');
  await page.route(workerPattern, delayWorkerResponse);
  routeInstalled = true;

  const result = await page.evaluate(async () => {
    const invoke = (command, args) =>
      window.__TAURI_INTERNALS__.invoke(command, args);
    const statusBefore = await invoke('nvidia_status');
    if (!statusBefore.ready) throw new Error(statusBefore.detail);
    const { createNvidiaDenoiser } =
      await import('/src/media/nvidiaDenoise.ts');

    const input = new AudioContext({ sampleRate: 48_000 });
    const oscillator = new OscillatorNode(input, { frequency: 440 });
    const inputGain = new GainNode(input, { gain: 0.1 });
    const inputDestination = input.createMediaStreamDestination();
    oscillator.connect(inputGain).connect(inputDestination);
    oscillator.start();
    await input.resume();
    const raw = inputDestination.stream.getAudioTracks()[0];
    let processed;
    let output;
    let source;
    let analyser;
    let silentDestination;
    let failure = null;
    try {
      processed = await createNvidiaDenoiser(raw, invoke);
      void processed.failure?.then((error) => {
        failure = String(error);
      });

      output = new AudioContext({ sampleRate: 48_000 });
      source = output.createMediaStreamSource(
        new MediaStream([processed.track]),
      );
      analyser = output.createAnalyser();
      analyser.fftSize = 256;
      const mute = new GainNode(output, { gain: 0 });
      silentDestination = output.createMediaStreamDestination();
      source.connect(analyser).connect(mute).connect(silentDestination);
      await output.resume();

      const samples = new Float32Array(analyser.fftSize);
      let blocks = 0;
      let nonFiniteSamples = 0;
      let recoveryObservedAt = null;
      let framesAtRecovery = null;
      let framesAfterRecovery = null;
      const startedAt = performance.now();
      const deadline = startedAt + 6_000;
      while (performance.now() < deadline) {
        analyser.getFloatTimeDomainData(samples);
        for (const sample of samples)
          if (!Number.isFinite(sample)) nonFiniteSamples++;
        blocks++;
        if (
          processed.diagnostics.underruns >= 1 &&
          recoveryObservedAt === null
        ) {
          recoveryObservedAt = performance.now();
          framesAtRecovery = processed.diagnostics.processedFrames;
        }
        if (
          framesAtRecovery !== null &&
          processed.diagnostics.processedFrames >= framesAtRecovery + 25
        )
          framesAfterRecovery = processed.diagnostics.processedFrames;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const statusAfter = await invoke('nvidia_status');
      const framesBeforeDispose = processed.diagnostics.processedFrames;
      const diagnostics = { ...processed.diagnostics };
      const measuredRunMs = performance.now() - startedAt;
      const measuredRecoveryObservationMs =
        recoveryObservedAt === null
          ? null
          : performance.now() - recoveryObservedAt;
      const outputBeforeDispose = processed.track.readyState;
      processed.dispose();
      processed.dispose();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const outputAfterDispose = processed.track.readyState;
      const rawAfterDispose = raw.readyState;
      raw.stop();
      return {
        statusBeforeReady: statusBefore.ready,
        statusAfterReady: statusAfter.ready,
        sampleRate: statusAfter.sampleRate,
        frameSamples: statusAfter.frameSamples,
        framesBeforeDispose,
        framesProgressedAfterRecovery:
          framesAtRecovery !== null &&
          framesAfterRecovery !== null &&
          framesAfterRecovery > framesAtRecovery,
        diagnostics,
        finiteAudio: blocks > 100 && nonFiniteSamples === 0,
        failure,
        measuredRunMs,
        measuredRecoveryObservationMs,
        outputBeforeDispose,
        outputAfterDispose,
        rawAfterDispose,
        rawAfterOwnerStop: raw.readyState,
      };
    } finally {
      processed?.dispose();
      source?.disconnect();
      analyser?.disconnect();
      silentDestination?.disconnect();
      if (output) await output.close().catch(() => undefined);
      if (raw.readyState !== 'ended') raw.stop();
      oscillator.stop();
      await input.close();
    }
  });

  assert.equal(result.statusBeforeReady, true);
  assert.equal(result.statusAfterReady, true);
  assert.equal(result.sampleRate, 48_000);
  assert.ok(result.frameSamples === 480 || result.frameSamples === 960);
  assert.ok(result.framesBeforeDispose > 200);
  assert.equal(result.framesProgressedAfterRecovery, true);
  assert.ok(result.diagnostics.underruns >= 1);
  assert.equal(result.diagnostics.bufferMs, 80);
  assert.equal(result.finiteAudio, true);
  assert.equal(result.failure, null);
  assert.equal(result.outputBeforeDispose, 'live');
  assert.equal(result.outputAfterDispose, 'ended');
  assert.equal(result.rawAfterDispose, 'live');
  assert.equal(result.rawAfterOwnerStop, 'ended');
  console.log(
    'PASS: actual NVIDIA audio recovered from one delayed native response.',
    {
      frameSamples: result.frameSamples,
      processedFrames: result.framesBeforeDispose,
      underruns: result.diagnostics.underruns,
      droppedFrames: result.diagnostics.droppedFrames,
      bufferMs: result.diagnostics.bufferMs,
      measuredRunMs: Math.round(result.measuredRunMs),
      measuredRecoveryObservationMs:
        result.measuredRecoveryObservationMs === null
          ? null
          : Math.round(result.measuredRecoveryObservationMs),
    },
  );
} finally {
  if (routeInstalled && page)
    await page
      .unroute(workerPattern, delayWorkerResponse)
      .catch(() => undefined);
  await browser.close(); // Disconnect CDP; the native application remains open.
}
