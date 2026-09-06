import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test('native system audio uses render-demand binary reads and preserves stereo PCM without speaker playback', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    Object.defineProperty(window, 'isTauri', {
      configurable: true,
      value: {},
    });
    const contexts: AudioContext[] = [];
    const OriginalAudioContext = window.AudioContext;
    class TrackedAudioContext extends OriginalAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
    }
    window.AudioContext = TrackedAudioContext;
    let speakerConnections = 0;
    const originalConnect = AudioNode.prototype.connect;
    (
      AudioNode.prototype as unknown as { connect(...args: unknown[]): unknown }
    ).connect = function (...args: unknown[]) {
      if (args[0] instanceof AudioDestinationNode) speakerConnections += 1;
      return (
        originalConnect as unknown as (...values: unknown[]) => unknown
      ).apply(this, args);
    };
    let intervalCalls = 0;
    const originalSetInterval = window.setInterval;
    window.setInterval = ((...args: Parameters<typeof window.setInterval>) => {
      intervalCalls += 1;
      return originalSetInterval(...args);
    }) as typeof window.setInterval;

    const commands: Array<{ command: string; args?: Record<string, unknown> }> =
      [];
    let phase = 0;
    let reads = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      commands.push({ command, args });
      if (command === 'native_system_audio_start')
        return { sessionId: 'stereo-session', sampleRate: 48_000, channels: 2 };
      if (command === 'native_system_audio_read') {
        reads += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 3));
        const frames = 960;
        const samples = new Float32Array(frames * 2);
        for (let frame = 0; frame < frames; frame += 1, phase += 1) {
          samples[frame * 2] =
            Math.sin((2 * Math.PI * 440 * phase) / 48_000) * 0.25;
          samples[frame * 2 + 1] =
            Math.sin((2 * Math.PI * 880 * phase) / 48_000) * 0.15;
        }
        inFlight -= 1;
        return samples.buffer;
      }
      if (command === 'native_system_audio_stop') return null;
      throw new Error(`Unexpected native command: ${command}`);
    };

    const { createNativeSystemAudio } =
      await import('/src/media/nativeSystemAudio.ts');
    const controller = new AbortController();
    const captured = await createNativeSystemAudio(controller.signal, invoke);
    const monitor = new OriginalAudioContext({ sampleRate: 48_000 });
    const source = monitor.createMediaStreamSource(
      new MediaStream([captured.track]),
    );
    const splitter = monitor.createChannelSplitter(2);
    const left = new AnalyserNode(monitor, {
      fftSize: 4096,
      smoothingTimeConstant: 0,
    });
    const right = new AnalyserNode(monitor, {
      fftSize: 4096,
      smoothingTimeConstant: 0,
    });
    source.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    await monitor.resume();

    const rms = (analyser: AnalyserNode) => {
      const values = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(values);
      return Math.sqrt(
        values.reduce((sum, value) => sum + value * value, 0) / values.length,
      );
    };
    let leftRms = 0;
    let rightRms = 0;
    const deadline = performance.now() + 4_000;
    while (
      performance.now() < deadline &&
      (leftRms < 0.02 || rightRms < 0.02 || reads < 4)
    ) {
      leftRms = Math.max(leftRms, rms(left));
      rightRms = Math.max(rightRms, rms(right));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const dominantFrequency = (analyser: AnalyserNode) => {
      const values = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(values);
      let peak = 1;
      for (let index = 2; index < values.length; index += 1)
        if (values[index] > values[peak]) peak = index;
      return (peak * monitor.sampleRate) / analyser.fftSize;
    };
    const leftHz = dominantFrequency(left);
    const rightHz = dominantFrequency(right);
    captured.dispose();
    captured.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const trackState = captured.track.readyState;
    const nativeContextState = contexts[0]?.state;
    await monitor.close();
    window.setInterval = originalSetInterval;
    (
      AudioNode.prototype as unknown as { connect: typeof originalConnect }
    ).connect = originalConnect;
    window.AudioContext = OriginalAudioContext;
    return {
      leftRms,
      rightRms,
      leftHz,
      rightHz,
      reads,
      maxInFlight,
      intervalCalls,
      speakerConnections,
      trackState,
      nativeContextState,
      commands,
    };
  });

  expect(result.leftRms).toBeGreaterThan(0.02);
  expect(result.rightRms).toBeGreaterThan(0.02);
  expect(result.leftHz).toBeGreaterThan(410);
  expect(result.leftHz).toBeLessThan(470);
  expect(result.rightHz).toBeGreaterThan(850);
  expect(result.rightHz).toBeLessThan(910);
  expect(result.reads).toBeGreaterThanOrEqual(4);
  expect(result.maxInFlight).toBe(1);
  expect(result.intervalCalls).toBe(0);
  expect(result.speakerConnections).toBe(0);
  expect(result.trackState).toBe('ended');
  expect(result.nativeContextState).toBe('closed');
  expect(
    result.commands.filter(
      ({ command }) => command === 'native_system_audio_stop',
    ),
  ).toEqual([
    {
      command: 'native_system_audio_stop',
      args: { sessionId: 'stereo-session' },
    },
  ]);
});

test('late native start after cancellation is stopped without creating audio resources', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    Object.defineProperty(window, 'isTauri', {
      configurable: true,
      value: {},
    });
    const OriginalAudioContext = window.AudioContext;
    let contextCount = 0;
    class CountedAudioContext extends OriginalAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contextCount += 1;
      }
    }
    window.AudioContext = CountedAudioContext;
    let resolveStart!: (session: unknown) => void;
    const commands: string[] = [];
    const invoke = (command: string) => {
      commands.push(command);
      if (command === 'native_system_audio_start')
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      return Promise.resolve(null);
    };
    const { createNativeSystemAudio } =
      await import('/src/media/nativeSystemAudio.ts');
    const controller = new AbortController();
    const pending = createNativeSystemAudio(controller.signal, invoke).catch(
      (error: DOMException) => error.name,
    );
    controller.abort();
    resolveStart({
      sessionId: 'late-session',
      sampleRate: 48_000,
      channels: 2,
    });
    const error = await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.AudioContext = OriginalAudioContext;
    return { error, commands, contextCount };
  });
  expect(result).toEqual({
    error: 'AbortError',
    commands: ['native_system_audio_start', 'native_system_audio_stop'],
    contextCount: 0,
  });
});

test('browser sessions reject native system audio before invoking the host', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    delete (window as unknown as { isTauri?: unknown }).isTauri;
    let calls = 0;
    const { createNativeSystemAudio } =
      await import('/src/media/nativeSystemAudio.ts');
    const error = await createNativeSystemAudio(
      new AbortController().signal,
      async () => {
        calls += 1;
      },
    ).catch((value: Error) => value.message);
    return { error, calls };
  });
  expect(result.calls).toBe(0);
  expect(result.error).toContain('desktop app');
});

test('native read failure reports once and releases the session, track, and context', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    Object.defineProperty(window, 'isTauri', {
      configurable: true,
      value: {},
    });
    const contexts: AudioContext[] = [];
    const OriginalAudioContext = window.AudioContext;
    class TrackedAudioContext extends OriginalAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
    }
    window.AudioContext = TrackedAudioContext;
    const commands: string[] = [];
    const invoke = async (command: string) => {
      commands.push(command);
      if (command === 'native_system_audio_start')
        return { sessionId: 'failed-session', sampleRate: 48_000, channels: 2 };
      if (command === 'native_system_audio_read')
        throw new Error('native read failed');
      return null;
    };
    const { createNativeSystemAudio } =
      await import('/src/media/nativeSystemAudio.ts');
    const captured = await createNativeSystemAudio(
      new AbortController().signal,
      invoke,
    );
    const error = await captured.failure;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = {
      message: error.message,
      commands,
      trackState: captured.track.readyState,
      contextState: contexts[0]?.state,
    };
    window.AudioContext = OriginalAudioContext;
    return output;
  });
  expect(result.message).toBe('native read failed');
  expect(result.trackState).toBe('ended');
  expect(result.contextState).toBe('closed');
  expect(
    result.commands.filter((command) => command === 'native_system_audio_stop'),
  ).toHaveLength(1);
});
