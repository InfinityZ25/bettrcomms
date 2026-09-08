import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test('DeepFilterNet3 WASM produces realtime mono audio and releases its output', async ({
  page,
}) => {
  const workletErrors: string[] = [];
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      message.text().toLowerCase().includes('deepfilter')
    )
      workletErrors.push(message.text());
  });
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const { createDeepfilterWasmDenoiser } =
      await import('/src/media/deepfilterWasmDenoise.ts');
    const sourceContext = new AudioContext({ sampleRate: 48_000 });
    const oscillator = new OscillatorNode(sourceContext, { frequency: 440 });
    const gain = new GainNode(sourceContext, { gain: 0.08 });
    const sourceDestination = sourceContext.createMediaStreamDestination();
    oscillator.connect(gain).connect(sourceDestination);
    oscillator.start();
    await sourceContext.resume();
    const raw = sourceDestination.stream.getAudioTracks()[0]!;
    const startedAt = performance.now();
    const processed = await createDeepfilterWasmDenoiser(raw, 100);
    const startupMs = performance.now() - startedAt;
    const monitor = new AudioContext({ sampleRate: 48_000 });
    const analyser = new AnalyserNode(monitor, {
      fftSize: 2048,
      smoothingTimeConstant: 0,
    });
    monitor
      .createMediaStreamSource(new MediaStream([processed.track]))
      .connect(analyser);
    await monitor.resume();
    const samples = new Float32Array(analyser.fftSize);
    let peakRms = 0;
    let activeFrames = 0;
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
      );
      peakRms = Math.max(peakRms, rms);
      if (rms > 0.00001) activeFrames += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const outputSettings = processed.track.getSettings();
    processed.dispose();
    const outputState = processed.track.readyState;
    const rawState = raw.readyState;
    raw.stop();
    oscillator.stop();
    await Promise.allSettled([sourceContext.close(), monitor.close()]);
    return {
      startupMs,
      peakRms,
      activeFrames,
      outputChannels: outputSettings.channelCount,
      outputState,
      rawState,
    };
  });

  expect(workletErrors).toEqual([]);
  expect(result.startupMs).toBeLessThan(30_000);
  expect(result.peakRms).toBeGreaterThan(0.00001);
  expect(result.activeFrames).toBeGreaterThan(20);
  expect(result.outputChannels).toBe(1);
  expect(result.outputState).toBe('ended');
  expect(result.rawState).toBe('live');
});

test('RNNoise remains the default while DeepFilterNet3 can be selected explicitly', async ({
  page,
}) => {
  await page.goto(baseURL);
  const defaults = await page.evaluate(async () => {
    const { readProcessingSettings, microphoneCaptureOptions } =
      await import('/src/media/processingSettings.ts');
    localStorage.removeItem('bc-denoiser');
    localStorage.removeItem('bc-noise');
    const initial = readProcessingSettings();
    localStorage.setItem('bc-denoiser', 'deepfilter-wasm');
    const saved = readProcessingSettings();
    return { initial, saved, capture: microphoneCaptureOptions() };
  });
  expect(defaults.initial.engine).toBe('rnnoise');
  expect(defaults.saved.engine).toBe('deepfilter-wasm');
  expect(defaults.capture.denoiser).toBe('deepfilter-wasm');
});
