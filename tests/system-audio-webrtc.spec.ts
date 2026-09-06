import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';

test('system audio remains distinct and audible across late add, stop, restart, and two senders', async ({ page }) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const { MediaEngine } = await import('/src/media/engine.ts');
    const waitFor = async <T>(read: () => T | undefined, timeout = 8_000) => {
      const deadline = performance.now() + timeout;
      let value: T | undefined;
      while (performance.now() < deadline && (value = read()) === undefined)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (value === undefined) throw new Error('Timed out waiting for remote media');
      return value;
    };
    const sources: AudioContext[] = [];
    const tones: OscillatorNode[] = [];
    const sourceNodes: AudioNode[] = [];
    const NativeAudioContext = window.AudioContext;
    let outputAnalyser: AnalyserNode | undefined;
    window.AudioContext = new Proxy(NativeAudioContext, {
      construct(Target, args) {
        const context = Reflect.construct(Target, args) as AudioContext;
        const createLimiter = context.createDynamicsCompressor.bind(context);
        Object.defineProperty(context, 'createDynamicsCompressor', { value: () => {
          const limiter = createLimiter();
          outputAnalyser = new AnalyserNode(context, { fftSize: 2048, smoothingTimeConstant: 0 });
          limiter.connect(outputAnalyser);
          return limiter;
        } });
        return context;
      },
    });
    const audio = await import('/src/media/remoteAudio.ts');
    audio.prepareCallPlayback();
    const detachPlayback: Array<() => void> = [];
    const tone = async (frequency: number) => {
      const context = new AudioContext({ sampleRate: 48_000 });
      const oscillator = new OscillatorNode(context, { frequency });
      const gain = new GainNode(context, { gain: 0.22 });
      const sink = new GainNode(context, { gain: 0 });
      const destination = context.createMediaStreamDestination();
      destination.channelCount = 1;
      oscillator.connect(gain).connect(destination);
      gain.connect(sink).connect(context.destination);
      oscillator.start();
      await context.resume();
      sources.push(context);
      tones.push(oscillator);
      // Keep the MediaStream destination graph strongly reachable for the call.
      sourceNodes.push(gain, sink, destination);
      return destination.stream.getAudioTracks()[0]!;
    };
    const receivedFrequency = async (track: MediaStreamTrack) => {
      const context = new AudioContext({ sampleRate: 48_000 });
      const analyser = new AnalyserNode(context, { fftSize: 8192, smoothingTimeConstant: 0 });
      const silent = new GainNode(context, { gain: 0 });
      context.createMediaStreamSource(new MediaStream([track])).connect(analyser).connect(silent).connect(context.destination);
      await context.resume();
      const bins = new Float32Array(analyser.frequencyBinCount);
      let peak = 2;
      const deadline = performance.now() + 4_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 40));
        analyser.getFloatFrequencyData(bins);
        peak = 2;
        for (let index = 3; index < bins.length; index += 1)
          if (bins[index] > bins[peak]) peak = index;
      } while (performance.now() < deadline && bins[peak] < -80);
      await context.close();
      return {
        frequency: peak * 48_000 / analyser.fftSize,
        peakDb: bins[peak],
        muted: track.muted,
        state: track.readyState,
      };
    };

    let a!: InstanceType<typeof MediaEngine>;
    let b!: InstanceType<typeof MediaEngine>;
    const failures: string[] = [];
    const signalingA = {
      localPeerId: 'a',
      send(signal: unknown) {
        queueMicrotask(() => void b.handleSignal({ ...(signal as object), from: 'a' } as never).catch((error) => failures.push(String(error))));
      },
    };
    const signalingB = {
      localPeerId: 'b',
      send(signal: unknown) {
        queueMicrotask(() => void a.handleSignal({ ...(signal as object), from: 'b' } as never).catch((error) => failures.push(String(error))));
      },
    };
    a = new MediaEngine({ signaling: signalingA });
    b = new MediaEngine({ signaling: signalingB });

    const localMicrophone = await tone(440);
    const localMicrophoneFrequency = await receivedFrequency(localMicrophone);
    await a.setLocalTrack('microphone', localMicrophone);
    a.addPeer('b');
    b.addPeer('a');
    const remoteMic = await waitFor(() => b.getRemoteTracks('a').find((item) => item.source === 'microphone')?.track);
    detachPlayback.push(audio.attachRemoteAudio({ track: remoteMic, peerId: 'a', balanceVoice: true }));
    const connectedDeadline = performance.now() + 8_000;
    while ((await b.getStats('a')).connectionState !== 'connected') {
      if (performance.now() >= connectedDeadline) throw new Error('Timed out waiting for connected peer');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await a.setLocalTrack('system', await tone(880));
    const firstSystem = await waitFor(() => b.getRemoteTracks('a').find((item) => item.source === 'system')?.track);
    detachPlayback.push(audio.attachRemoteAudio({ track: firstSystem, peerId: 'a', balanceVoice: false }));
    const lateSystemFrequency = await receivedFrequency(firstSystem);
    await b.setLocalTrack('system', await tone(660));
    const simultaneousSystem = await waitFor(() => a.getRemoteTracks('b').find((item) => item.source === 'system')?.track);
    detachPlayback.push(audio.attachRemoteAudio({ track: simultaneousSystem, peerId: 'b', balanceVoice: false }));

    await a.setLocalTrack('system', null);
    await waitFor(() => b.getRemoteTracks('a').some((item) => item.source === 'system') ? undefined : true);
    await a.setLocalTrack('system', await tone(990));
    const restartedSystem = await waitFor(() => {
      const track = b.getRemoteTracks('a').find((item) => item.source === 'system')?.track;
      return track && track.id !== firstSystem.id ? track : undefined;
    });
    detachPlayback.push(audio.attachRemoteAudio({ track: restartedSystem, peerId: 'a', balanceVoice: false }));

    const frequencies = {
      microphone: await receivedFrequency(remoteMic),
      lateSystem: lateSystemFrequency,
      simultaneousSystem: await receivedFrequency(simultaneousSystem),
      restartedSystem: await receivedFrequency(restartedSystem),
    };

    const audible = async () => {
      let peak = 0;
      const values = new Float32Array(2048);
      const deadline = performance.now() + 2_000;
      while (performance.now() < deadline && peak < 0.0002) {
        outputAnalyser!.getFloatTimeDomainData(values);
        peak = Math.max(peak, Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length));
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return peak;
    };
    const playback: { combined: number; muted: number } = {
      combined: await audible(),
      muted: 0,
    };
    const decoderElements = [...document.querySelectorAll('audio')];
    const decoderElementsMuted = decoderElements.length >= 3
      && decoderElements.every((element) => element.muted);
    window.dispatchEvent(new CustomEvent('bc-volume', { detail: { peerId: 'a', volume: 0 } }));
    window.dispatchEvent(new CustomEvent('bc-volume', { detail: { peerId: 'b', volume: 0 } }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const silentValues = new Float32Array(2048);
    outputAnalyser!.getFloatTimeDomainData(silentValues);
    playback.muted = Math.sqrt(silentValues.reduce((sum, value) => sum + value * value, 0) / silentValues.length);
    for (const detach of detachPlayback) detach();
    audio.disposeCallPlayback();
    const retainedAudioElements = document.querySelectorAll('audio').length;
    a.dispose();
    b.dispose();
    for (const oscillator of tones) { try { oscillator.stop(); } catch { /* stopped by engine ownership */ } }
    await Promise.allSettled(sources.map((context) => context.close()));
    return { frequencies, playback, failures, localMicrophoneFrequency, retainedSourceNodes: sourceNodes.length, retainedAudioElements, decoderElementsMuted };
  });

  expect(result.failures).toEqual([]);
  expect(Math.abs(result.localMicrophoneFrequency.frequency - 440)).toBeLessThan(25);
  expect(Math.abs(result.frequencies.microphone.frequency - 440)).toBeLessThan(25);
  expect(Math.abs(result.frequencies.lateSystem.frequency - 880)).toBeLessThan(25);
  expect(Math.abs(result.frequencies.simultaneousSystem.frequency - 660)).toBeLessThan(25);
  expect(Math.abs(result.frequencies.restartedSystem.frequency - 990)).toBeLessThan(25);
  for (const sample of Object.values(result.frequencies))
    expect(sample.peakDb).toBeGreaterThan(-80);
  expect(result.playback.combined).toBeGreaterThan(0.0002);
  expect(result.playback.muted).toBeLessThan(0.00002);
  expect(result.decoderElementsMuted).toBe(true);
  expect(result.retainedAudioElements).toBe(0);
});
