import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test('Speex emits decoded audio and releases only its processed track', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const { createSpeexDenoiser } = await import('/src/media/speexDenoise.ts');
    const input = new AudioContext({ sampleRate: 48_000 });
    const oscillator = new OscillatorNode(input, { frequency: 440 });
    const gain = new GainNode(input, { gain: 0.3 });
    const destination = input.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await input.resume();
    const raw = destination.stream.getAudioTracks()[0]!;
    const processed = await createSpeexDenoiser(raw);
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
    const deadline = performance.now() + 4_000;
    while (performance.now() < deadline && peakRms < 0.0001) {
      analyser.getFloatTimeDomainData(samples);
      peakRms = Math.max(
        peakRms,
        Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) /
            samples.length,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    processed.dispose();
    processed.dispose();
    const outputState = processed.track.readyState;
    const rawState = raw.readyState;
    raw.stop();
    oscillator.stop();
    await Promise.allSettled([input.close(), monitor.close()]);
    return { peakRms, outputState, rawState };
  });
  expect(result.peakRms).toBeGreaterThan(0.0001);
  expect(result.outputState).toBe('ended');
  expect(result.rawState).toBe('live');
});

test('Speex selection drives capture constraints and the shared engine', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('bc-denoiser', 'speex');
    localStorage.setItem('bc-noise', 'on');
  });
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const { readProcessingSettings, microphoneCaptureOptions } =
      await import('/src/media/processingSettings.ts');
    const { MediaEngine } = await import('/src/media/engine.ts');
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    let captured: MediaStreamConstraints | undefined;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: (constraints: MediaStreamConstraints) => {
        captured = constraints;
        return original(constraints);
      },
    });
    const options = microphoneCaptureOptions();
    const engine = new MediaEngine({
      signaling: { localPeerId: 'test', send() {} },
    });
    await engine.captureUserMedia(options);
    const track = engine.getLocalTracks().get('microphone')!;
    const stateBeforeDispose = track.readyState;
    engine.dispose();
    return {
      settings: readProcessingSettings(),
      options,
      captured,
      stateBeforeDispose,
      stateAfterDispose: track.readyState,
    };
  });
  expect(result.settings.engine).toBe('speex');
  expect(result.options).toMatchObject({
    denoiser: 'speex',
    noiseSuppression: false,
  });
  expect(result.captured?.audio).toMatchObject({ noiseSuppression: false });
  expect(result.stateBeforeDispose).toBe('live');
  expect(result.stateAfterDispose).toBe('ended');
});

test('Speex attenuates stationary broadband noise after adaptation', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const { createSpeexDenoiser } = await import('/src/media/speexDenoise.ts');
    const input = new AudioContext({ sampleRate: 48_000 });
    const noiseBuffer = input.createBuffer(1, 48_000, 48_000);
    const samples = noiseBuffer.getChannelData(0);
    let state = 0x12345678;
    for (let i = 0; i < samples.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      samples[i] = ((state / 0xffffffff) * 2 - 1) * 0.12;
    }
    const source = new AudioBufferSourceNode(input, {
      buffer: noiseBuffer,
      loop: true,
    });
    const destination = input.createMediaStreamDestination();
    source.connect(destination);
    source.start();
    await input.resume();
    const raw = destination.stream.getAudioTracks()[0]!;
    const processed = await createSpeexDenoiser(raw);
    const monitor = new AudioContext({ sampleRate: 48_000 });
    const rawAnalyser = new AnalyserNode(monitor, {
      fftSize: 4096,
      smoothingTimeConstant: 0,
    });
    const processedAnalyser = new AnalyserNode(monitor, {
      fftSize: 4096,
      smoothingTimeConstant: 0,
    });
    monitor
      .createMediaStreamSource(new MediaStream([raw]))
      .connect(rawAnalyser);
    monitor
      .createMediaStreamSource(new MediaStream([processed.track]))
      .connect(processedAnalyser);
    await monitor.resume();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const rms = (analyser: AnalyserNode) => {
      const values = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(values);
      return Math.sqrt(
        values.reduce((sum, value) => sum + value * value, 0) / values.length,
      );
    };
    const measurements = [];
    for (let i = 0; i < 8; i += 1) {
      measurements.push({
        raw: rms(rawAnalyser),
        processed: rms(processedAnalyser),
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    const rawRms = Math.max(...measurements.map((value) => value.raw));
    const processedRms = Math.max(
      ...measurements.map((value) => value.processed),
    );
    processed.dispose();
    raw.stop();
    source.stop();
    await Promise.allSettled([input.close(), monitor.close()]);
    return { rawRms, processedRms, ratio: processedRms / rawRms };
  });
  expect(result.rawRms).toBeGreaterThan(0.04);
  expect(result.processedRms).toBeGreaterThan(0);
  expect(result.ratio).toBeLessThan(0.75);
});

test('Speex input failure removes the processed microphone and reports the error', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const { MediaEngine } = await import('/src/media/engine.ts');
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    let raw: MediaStreamTrack | undefined;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        const stream = await original(constraints);
        raw = stream.getAudioTracks()[0];
        return stream;
      },
    });
    const engine = new MediaEngine({
      signaling: { localPeerId: 'test', send() {} },
    });
    let operation = '';
    engine.addEventListener('error', (event) => {
      operation = event.detail.operation;
    });
    await engine.captureUserMedia({
      camera: false,
      microphone: true,
      denoiser: 'speex',
    });
    const processed = engine.getLocalTracks().get('microphone')!;
    raw!.dispatchEvent(new Event('ended'));
    raw!.stop();
    const deadline = performance.now() + 2_000;
    while (
      performance.now() < deadline &&
      engine.getLocalTracks().has('microphone')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const removed = !engine.getLocalTracks().has('microphone');
    const processedState = processed.readyState;
    engine.dispose();
    return { removed, processedState, operation };
  });
  expect(result.removed).toBe(true);
  expect(result.processedState).toBe('ended');
  expect(result.operation).toBe('speex-denoiser');
});
