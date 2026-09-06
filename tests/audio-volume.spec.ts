import { expect, test } from '@playwright/test';

test('input volume changes the same processed track live without changing capture', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const volume = await import('/src/media/volumeSettings.ts');
    const { readProcessingSettings } = await import('/src/media/processingSettings.ts');
    const { createMicrophoneEffects } = await import('/src/media/microphoneEffects.ts');
    const context = new AudioContext();
    const oscillator = new OscillatorNode(context, { frequency: 480 });
    const level = new GainNode(context, { gain: 0.04 });
    const destination = context.createMediaStreamDestination();
    oscillator.connect(level).connect(destination); oscillator.start(); await context.resume();
    const raw = destination.stream.getAudioTracks()[0];
    volume.setInputVolume(1);
    const processed = await createMicrophoneEffects(raw, readProcessingSettings());
    const analyser = new AnalyserNode(context, { fftSize: 8192 });
    context.createMediaStreamSource(new MediaStream([processed.track])).connect(analyser);
    const rms = async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      const samples = new Float32Array(8192); analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    };
    const one = await rms(); volume.setInputVolume(2); const two = await rms();
    volume.setInputVolume(0); const zero = await rms();
    const live = processed.track.readyState;
    const persisted = readProcessingSettings();
    processed.dispose(); const rawLive = raw.readyState;
    raw.stop(); oscillator.stop(); await context.close();
    return { one, two, zero, live, rawLive, persisted };
  });
  expect(result.one).toBeGreaterThan(0.001);
  expect(result.two / result.one).toBeGreaterThan(1.9);
  expect(result.two / result.one).toBeLessThan(2.1);
  expect(result.zero).toBeLessThan(0.00001);
  expect(result.live).toBe('live'); expect(result.rawLive).toBe('live');
  expect(result.persisted).toMatchObject({ inputVolume: 0, gainDb: 0 });
});

test('global output volume scales call playback without altering the source or participant volume', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const volume = await import('/src/media/volumeSettings.ts');
    const input = new AudioContext();
    const oscillator = new OscillatorNode(input, { frequency: 480 });
    const level = new GainNode(input, { gain: 0.02 });
    const destination = input.createMediaStreamDestination();
    oscillator.connect(level).connect(destination); oscillator.start(); await input.resume();
    const Context = window.AudioContext;
    let meter!: AnalyserNode;
    window.AudioContext = new Proxy(Context, { construct(Target, args) {
      const context = Reflect.construct(Target, args) as AudioContext;
      const create = context.createDynamicsCompressor.bind(context);
      context.createDynamicsCompressor = () => {
        const limiter = create(); meter = new AnalyserNode(context, { fftSize: 8192 }); limiter.connect(meter); return limiter;
      };
      return context;
    } });
    const audio = await import('/src/media/remoteAudio.ts');
    volume.setOutputVolume(1); localStorage.setItem('bc-volume-test-peer', '0.5');
    audio.prepareCallPlayback();
    const track = destination.stream.getAudioTracks()[0];
    const detach = audio.attachRemoteAudio({ track, peerId: 'test-peer', balanceVoice: false });
    const rms = async () => {
      // Let the gain ramp and the 8192-frame analysis window settle on slower audio backends.
      const settledAt = meter.context.currentTime + 0.5;
      while (meter.context.currentTime < settledAt) await new Promise(resolve => setTimeout(resolve, 25));
      const samples = new Float32Array(8192); meter.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    };
    const one = await rms(); volume.setOutputVolume(2); const two = await rms();
    volume.setOutputVolume(0); const zero = await rms();
    const participant = audio.readParticipantVolume('test-peer');
    const sourceGain = level.gain.value; const sourceLive = track.readyState;
    detach(); audio.disposeCallPlayback();
    const consumers = document.querySelectorAll('audio').length;
    oscillator.stop(); track.stop(); await input.close(); window.AudioContext = Context;
    return { one, two, zero, participant, sourceGain, sourceLive, consumers };
  });
  expect(result.one).toBeGreaterThan(0.001);
  expect(result.two / result.one).toBeGreaterThan(1.9);
  expect(result.two / result.one).toBeLessThan(2.1);
  expect(result.zero).toBeLessThan(0.00001);
  expect(result.participant).toBe(0.5); expect(result.sourceGain).toBeCloseTo(0.02);
  expect(result.sourceLive).toBe('live'); expect(result.consumers).toBe(0);
});

