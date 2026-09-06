import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test('processing controls apply tuning to calls and identify an RNNoise microphone sample', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('bc-denoiser', 'rnnoise'),
  );
  await page.goto(baseURL);
  await page.getByRole('button', { name: /audio and video settings/i }).click();
  await page.getByText('Advanced audio controls', { exact: true }).click();
  await page.getByLabel('Echo cancellation').uncheck();
  await page.getByLabel('Automatic microphone gain').check();
  await page.getByLabel('Low-cut filter').selectOption('100');
  await page.getByRole('slider', { name: 'Input volume' }).fill('1.5');
  await page.getByLabel('Quiet-sound gate').check();
  await page.getByRole('slider', { name: 'Gate threshold' }).fill('-38');
  await page.getByRole('button', { name: 'Apply microphone settings' }).click();
  await expect(
    page.getByText('Applied to calls and microphone tests.'),
  ).toBeVisible();
  await page.screenshot({
    path: '.local/processing-settings.png',
    fullPage: true,
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('bc-processing') ?? '{}'),
      ),
    )
    .toMatchObject({
      echoCancellation: false,
      autoGainControl: true,
      highPassHz: 100,
      gainDb: 0,
      inputVolume: 1.5,
      gateEnabled: true,
      gateThresholdDb: -38,
    });
  await page.getByRole('button', { name: 'Test microphone' }).click();
  await expect(
    page.getByText('Recording a 5-second RNNoise sample…'),
  ).toBeVisible();
  await page
    .getByRole('checkbox', { name: /noise suppression reduce/i })
    .uncheck();
  await page.getByRole('button', { name: 'Test microphone' }).click();
  await expect(
    page.getByText('Recording a 5-second Suppression off sample…'),
  ).toBeVisible();
  const offOptions = await page.evaluate(async () => {
    const { microphoneCaptureOptions } =
      await import('/src/media/processingSettings.ts');
    return microphoneCaptureOptions();
  });
  expect(offOptions).toMatchObject({
    denoiser: 'off',
    noiseSuppression: false,
  });
  await page.keyboard.press('Escape');
});

test('central input and output volume controls are bounded and persist', async ({ page }) => {
  await page.goto(baseURL);
  await page.getByRole('button', { name: /audio and video settings/i }).click();
  const input = page.getByRole('slider', { name: 'Input volume' });
  const output = page.getByRole('slider', { name: 'Output volume' });
  await expect(input).toHaveAttribute('min', '0');
  await expect(input).toHaveAttribute('max', '2');
  await expect(output).toHaveAttribute('min', '0');
  await expect(output).toHaveAttribute('max', '2');
  await expect(input).toHaveValue('1');
  await expect(output).toHaveValue('1');
  await input.fill('1.5');
  await output.fill('0.65');
  await page.screenshot({ path: '.local/central-audio-settings-1280.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: /audio and video settings/i }).click();
  await expect(page.getByRole('slider', { name: 'Input volume' })).toHaveValue('1.5');
  await expect(page.getByRole('slider', { name: 'Output volume' })).toHaveValue('0.65');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.local/central-audio-settings-mobile.png', fullPage: true });
  await expect.poll(() => page.evaluate(() => ({
    input: JSON.parse(localStorage.getItem('bc-processing') ?? '{}').inputVolume,
    output: Number(localStorage.getItem('bc-output-volume')),
  }))).toEqual({ input: 1.5, output: 0.65 });
});

test('stored microphone processing drives browser capture and rejects stale browser NVIDIA selection', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const {
      readProcessingSettings,
      saveProcessingSettings,
      microphoneCaptureOptions,
    } = await import('/src/media/processingSettings.ts');
    const { MediaEngine } = await import('/src/media/engine.ts');
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    const captures: MediaStreamConstraints[] = [];
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        captures.push(constraints);
        return original(constraints);
      },
    });

    localStorage.setItem('bc-denoiser', 'nvidia');
    localStorage.setItem(
      'bc-processing',
      JSON.stringify({
        echoCancellation: false,
        autoGainControl: true,
        nvidiaIntensity: 8,
        highPassHz: 9_000,
        gainDb: -90,
        gateThresholdDb: 20,
        gateAttackMs: -2,
        gateHoldMs: 90_000,
        gateReleaseMs: 90_000,
      }),
    );
    const normalized = readProcessingSettings();
    const saved = saveProcessingSettings({ gainDb: 6, gateEnabled: true });
    const options = microphoneCaptureOptions('chosen-microphone');
    const engine = new MediaEngine({
      signaling: { localPeerId: 'test', send() {} },
    });
    await engine.captureUserMedia(microphoneCaptureOptions());
    const track = engine.getLocalTracks().get('microphone');
    engine.dispose();
    return {
      normalized,
      saved,
      options,
      constraints: captures[0],
      trackKind: track?.kind,
      trackAfterDispose: track?.readyState,
    };
  });

  expect(result.normalized).toMatchObject({
    engine: 'standard',
    echoCancellation: false,
    autoGainControl: true,
    nvidiaIntensity: 1,
    highPassHz: 2_000,
    gainDb: -24,
    gateThresholdDb: 0,
    gateAttackMs: 0,
    gateHoldMs: 5_000,
    gateReleaseMs: 5_000,
  });
  expect(result.saved).toMatchObject({
    engine: 'standard',
    gainDb: 6,
    gateEnabled: true,
  });
  expect(result.options).toMatchObject({
    camera: false,
    denoiser: 'standard',
    noiseSuppression: true,
    echoCancellation: false,
    autoGainControl: true,
    microphone: { deviceId: { exact: 'chosen-microphone' } },
  });
  expect(result.constraints.video).toBe(false);
  expect(result.constraints.audio).toMatchObject({
    noiseSuppression: true,
    echoCancellation: false,
    autoGainControl: true,
  });
  expect(result.trackKind).toBe('audio');
  expect(result.trackAfterDispose).toBe('ended');
});

test('RNNoise capture disables browser suppression and produces decoded processed audio', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
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
    const engine = new MediaEngine({
      signaling: { localPeerId: 'test', send() {} },
    });
    await engine.captureUserMedia({
      camera: false,
      microphone: true,
      denoiser: 'rnnoise',
    });
    const track = engine.getLocalTracks().get('microphone')!;
    const context = new AudioContext({ sampleRate: 48_000 });
    const analyser = new AnalyserNode(context, {
      fftSize: 2048,
      smoothingTimeConstant: 0,
    });
    context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    await context.resume();
    const samples = new Float32Array(analyser.fftSize);
    let peakRms = 0;
    const deadline = performance.now() + 4_000;
    while (performance.now() < deadline && peakRms < 0.0001) {
      analyser.getFloatTimeDomainData(samples);
      peakRms = Math.max(
        peakRms,
        Math.sqrt(
          samples.reduce((sum, value) => sum + value * value, 0) /
            samples.length,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    engine.dispose();
    await context.close();
    return { captured, peakRms, state: track.readyState };
  });
  expect(result.captured?.audio).toMatchObject({ noiseSuppression: false, channelCount: { ideal: 1 } });
  expect(result.peakRms).toBeGreaterThan(0.0001);
  expect(result.state).toBe('ended');
});

test('microphone gate attenuates a below-threshold signal, passes speech level audio, and cleans up', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const { createMicrophoneEffects } =
      await import('/src/media/microphoneEffects.ts');
    const sourceContext = new AudioContext({ sampleRate: 48_000 });
    const oscillator = new OscillatorNode(sourceContext, { frequency: 440 });
    const gain = new GainNode(sourceContext, { gain: 0.0001 });
    const destination = sourceContext.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await sourceContext.resume();
    const raw = destination.stream.getAudioTracks()[0]!;
    const processed = await createMicrophoneEffects(raw, {
      engine: 'off',
      echoCancellation: false,
      autoGainControl: false,
      nvidiaIntensity: 1,
      nvidiaVad: false,
      highPassHz: 0,
      gainDb: 0,
      gateEnabled: true,
      gateThresholdDb: -30,
      gateAttackMs: 3,
      gateHoldMs: 10,
      gateReleaseMs: 30,
    });
    const monitor = new AudioContext({ sampleRate: 48_000 });
    const analyser = new AnalyserNode(monitor, {
      fftSize: 2048,
      smoothingTimeConstant: 0,
    });
    monitor
      .createMediaStreamSource(new MediaStream([processed.track]))
      .connect(analyser);
    await monitor.resume();
    const rms = async (settle: number) => {
      await new Promise((resolve) => setTimeout(resolve, settle));
      const values = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(values);
      return Math.sqrt(
        values.reduce((sum, value) => sum + value * value, 0) / values.length,
      );
    };
    const below = await rms(250);
    gain.gain.setValueAtTime(0.2, sourceContext.currentTime);
    const above = await rms(250);
    processed.dispose();
    const outputState = processed.track.readyState;
    const rawState = raw.readyState;
    raw.stop();
    oscillator.stop();
    await Promise.allSettled([sourceContext.close(), monitor.close()]);
    return { below, above, outputState, rawState };
  });
  expect(Number.isFinite(result.below)).toBe(true);
  expect(Number.isFinite(result.above)).toBe(true);
  expect(result.below).toBeLessThan(0.00002);
  expect(result.above).toBeGreaterThan(0.02);
  expect(result.outputState).toBe('ended');
  expect(result.rawState).toBe('live');
});
