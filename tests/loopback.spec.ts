import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

async function installLoopbackHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    const contexts: AudioContext[] = [];
    const captureTracks: MediaStreamTrack[] = [];
    const captureConstraints: MediaStreamConstraints[] = [];
    const sinkIds: string[] = [];
    const monitorGains = new WeakSet<AudioNode>();
    let delayAnalyser: AnalyserNode | undefined;
    let delayCount = 0;
    let sourceContext: AudioContext | undefined;
    let sourceOscillator: OscillatorNode | undefined;
    let sourceGain: GainNode | undefined;
    let recorderCount = 0;
    let pending = false;
    let resolvePending: ((stream: MediaStream) => void) | undefined;

    class TrackedAudioContext extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
    }
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: TrackedAudioContext,
    });

    const nativeCreateDelay = NativeAudioContext.prototype.createDelay;
    Object.defineProperty(NativeAudioContext.prototype, 'createDelay', {
      configurable: true,
      value(this: AudioContext, maximumDelayTime?: number) {
        const delay = nativeCreateDelay.call(this, maximumDelayTime);
        delayCount += 1;
        delayAnalyser = this.createAnalyser();
        delayAnalyser.fftSize = 2048;
        delayAnalyser.smoothingTimeConstant = 0;
        delay.connect(delayAnalyser);
        return delay;
      },
    });

    const nativeConnect = AudioNode.prototype.connect;
    Object.defineProperty(AudioNode.prototype, 'connect', {
      configurable: true,
      value(this: AudioNode, destination: AudioNode, ...rest: number[]) {
        if (this instanceof DelayNode && destination instanceof GainNode)
          monitorGains.add(destination);
        if (
          monitorGains.has(this) &&
          destination instanceof AudioDestinationNode
        ) {
          const silent = this.context.createMediaStreamDestination();
          return nativeConnect.call(this, silent, ...rest);
        }
        return nativeConnect.call(this, destination, ...rest);
      },
    });

    Object.defineProperty(NativeAudioContext.prototype, 'setSinkId', {
      configurable: true,
      value(id: string) {
        sinkIds.push(id);
        return Promise.resolve();
      },
    });

    const NativeMediaRecorder = window.MediaRecorder;
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: new Proxy(NativeMediaRecorder, {
        construct(target, args) {
          recorderCount += 1;
          return Reflect.construct(target, args);
        },
      }),
    });

    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    Object.defineProperty(EventTarget.prototype, 'addEventListener', {
      configurable: true,
      value(
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type === 'denoiser-status')
          (window as unknown as { __testEngine?: EventTarget }).__testEngine =
            this;
        return nativeAddEventListener.call(this, type, listener, options);
      },
    });

    const makeStream = async () => {
      sourceContext = new NativeAudioContext({ sampleRate: 48_000 });
      const oscillator = sourceContext.createOscillator();
      const gain = sourceContext.createGain();
      const destination = sourceContext.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      gain.gain.value = 0.2;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      sourceOscillator = oscillator;
      sourceGain = gain;
      await sourceContext.resume();
      const track = destination.stream.getAudioTracks()[0]!;
      captureTracks.push(track);
      return new MediaStream([track]);
    };

    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        captureConstraints.push(constraints);
        const stream = await makeStream();
        if (!pending) return stream;
        return new Promise<MediaStream>((resolve) => {
          resolvePending = () => resolve(stream);
        });
      },
    });

    const rms = () => {
      if (!delayAnalyser) return -1;
      const values = new Float32Array(delayAnalyser.fftSize);
      delayAnalyser.getFloatTimeDomainData(values);
      return Math.sqrt(
        values.reduce((sum, value) => sum + value * value, 0) / values.length,
      );
    };

    const observeRms = async (durationMs: number, intervalMs = 50) => {
      const samples: number[] = [];
      const started = performance.now();
      while (performance.now() - started < durationMs) {
        samples.push(rms());
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      return samples;
    };

    Object.assign(window, {
      __loopback: {
        rms,
        observeRms,
        snapshot: () => ({
          contextStates: contexts.map((context) => context.state),
          trackStates: captureTracks.map((track) => track.readyState),
          captureConstraints,
          recorderCount,
          delayCount,
          sinkIds: [...sinkIds],
        }),
        setPending: () => {
          pending = true;
        },
        setSignal: (frequency: number, gain: number) => {
          if (!sourceOscillator || !sourceGain)
            throw new Error('Synthetic microphone is not running.');
          sourceOscillator.frequency.value = frequency;
          sourceGain.gain.value = gain;
        },
        makeReplacement: async (frequency: number, gainValue: number) => {
          const context = new NativeAudioContext({ sampleRate: 48_000 });
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const destination = context.createMediaStreamDestination();
          oscillator.frequency.value = frequency;
          gain.gain.value = gainValue;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          await context.resume();
          const track = destination.stream.getAudioTracks()[0]!;
          captureTracks.push(track);
          sourceOscillator = oscillator;
          sourceGain = gain;
          sourceContext = context;
          return track;
        },
        resolvePending: () => {
          pending = false;
          resolvePending?.(new MediaStream());
        },
        closeSource: async () => {
          sourceOscillator?.stop();
          if (sourceContext?.state !== 'closed') await sourceContext?.close();
        },
      },
    });
  });
}

async function openSettings(page: Page): Promise<void> {
  await page.goto(`${baseURL}/#/settings`);
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
}

test('microphone diagnostics separate captured and processed levels without copying device identifiers', async ({ page }) => {
  await installLoopbackHarness(page);
  await page.addInitScript(() => {
    localStorage.setItem('bc-denoiser', 'off');
    localStorage.setItem('bc-processing', JSON.stringify({ gainDb: -12, echoCancellation: false, autoGainControl: false }));
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async (text: string) => { (window as any).__copiedMicDiagnostics = JSON.parse(text); },
    });
  });
  await openSettings(page);
  await page.getByRole('button', { name: 'Start live loopback' }).click();
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Copy microphone diagnostics' }).click();
    return page.evaluate(() => (window as any).__copiedMicDiagnostics?.levelsDbfs.processedPeak ?? -120);
  }).toBeGreaterThan(-40);
  const report = await page.evaluate(() => (window as any).__copiedMicDiagnostics);
  expect(report.inputAvailable).toBe(true);
  expect(report.inputFormat.channelCount).toBe(2);
  expect(report.inputChannelsDbfs).toHaveLength(2);
  expect(report.inputChannelsDbfs[0].peak).toBeGreaterThan(-30);
  expect(report.inputChannelsDbfs[1].peak).toBeCloseTo(report.inputChannelsDbfs[0].peak, 0);
  expect(report.processedFormat.channelCount).toBe(1);
  expect(report.requestedProcessing.gainDb).toBe(-12);
  expect(report.levelsDbfs.processedPeak - report.levelsDbfs.inputPeak).toBeCloseTo(-12, 0);
  expect(JSON.stringify(report)).not.toMatch(/deviceId|groupId|label|token|credential/i);
  await page.getByRole('button', { name: 'Stop live loopback' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__loopback.snapshot().contextStates)).toEqual(['closed', 'closed']);
  await page.evaluate(() => (window as any).__loopback.closeSource());
});

test('live loopback uses the processed microphone, a real one-second delay, monitor gain, and selected output', async ({
  page,
}) => {
  await installLoopbackHarness(page);
  await page.addInitScript(() => {
    localStorage.setItem('bc-denoiser', 'off');
    localStorage.setItem('bc-output', 'headphones-test');
  });
  await openSettings(page);

  await page.getByRole('button', { name: 'Start live loopback' }).click();
  await expect(
    page.getByText('Live loopback · Suppression off · 1-second delay.'),
  ).toBeVisible();
  const volume = page.getByRole('slider', { name: 'Monitor volume' });
  await expect(volume).toHaveValue('0.5');
  await expect(page.getByText('Monitor volume · 50%')).toBeVisible();

  await page.waitForTimeout(600);
  const early = await page.evaluate(() =>
    (window as unknown as { __loopback: { rms(): number } }).__loopback.rms(),
  );
  await page.waitForTimeout(650);
  const delayed = await page.evaluate(() =>
    (window as unknown as { __loopback: { rms(): number } }).__loopback.rms(),
  );
  expect(early).toBeLessThan(0.0001);
  expect(delayed).toBeGreaterThan(0.02);

  await volume.fill('0.25');
  await expect(page.getByText('Monitor volume · 25%')).toBeVisible();
  const active = await page.evaluate(() =>
    (
      window as unknown as {
        __loopback: {
          snapshot(): { recorderCount: number; sinkIds: string[] };
        };
      }
    ).__loopback.snapshot(),
  );
  expect(active.recorderCount).toBe(0);
  expect(active.sinkIds).toContain('headphones-test');
  const constraints = await page.evaluate(
    () =>
      (
        window as unknown as {
          __loopback: {
            snapshot(): { captureConstraints: MediaStreamConstraints[] };
          };
        }
      ).__loopback.snapshot().captureConstraints,
  );
  expect(constraints[0]?.audio).toMatchObject({ echoCancellation: false });
  await page.screenshot({ path: '.local/loopback.png', fullPage: true });

  await page.getByRole('button', { name: 'Stop live loopback' }).click();
  await expect(page.getByText('Live loopback stopped.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start live loopback' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __loopback: {
              snapshot(): { contextStates: string[]; trackStates: string[] };
            };
          }
        ).__loopback.snapshot(),
      ),
    )
    // The stereo fixture needs a mono conversion context plus the monitor.
    .toMatchObject({ contextStates: ['closed', 'closed'], trackStates: ['ended'] });
  await page.evaluate(() =>
    (
      window as unknown as { __loopback: { closeSource(): Promise<void> } }
    ).__loopback.closeSource(),
  );
});

test('sample and live modes replace each other, processing changes stop samples, and stale browser NVIDIA stays standard', async ({
  page,
}) => {
  await installLoopbackHarness(page);
  await page.addInitScript(() => localStorage.setItem('bc-denoiser', 'nvidia'));
  await openSettings(page);

  await page.getByRole('button', { name: 'Start live loopback' }).click();
  await expect(
    page.getByText('Live loopback · Browser · 1-second delay.'),
  ).toBeVisible();
  let snapshot = await page.evaluate(() =>
    (
      window as unknown as {
        __loopback: {
          snapshot(): {
            recorderCount: number;
            captureConstraints: MediaStreamConstraints[];
          };
        };
      }
    ).__loopback.snapshot(),
  );
  expect(snapshot.recorderCount).toBe(0);
  expect(snapshot.captureConstraints[0]?.audio).toMatchObject({
    noiseSuppression: true,
    echoCancellation: false,
  });

  await page.getByRole('button', { name: 'Test microphone' }).click();
  await expect(
    page.getByText('Recording a 5-second Browser sample…'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start live loopback' }),
  ).toBeVisible();
  snapshot = await page.evaluate(() =>
    (
      window as unknown as {
        __loopback: {
          snapshot(): {
            recorderCount: number;
            captureConstraints: MediaStreamConstraints[];
          };
        };
      }
    ).__loopback.snapshot(),
  );
  expect(snapshot.recorderCount).toBe(1);
  expect(snapshot.captureConstraints[1]?.audio).toMatchObject({
    echoCancellation: true,
  });

  await page.getByRole('button', { name: 'Start live loopback' }).click();
  await expect(
    page.getByText('Live loopback · Browser · 1-second delay.'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __loopback: { snapshot(): { recorderCount: number } };
          }
        ).__loopback.snapshot().recorderCount,
    ),
  ).toBe(1);

  await page.evaluate(() => window.dispatchEvent(new Event('bc-processing')));
  await expect(
    page.getByText(
      'Processing settings changed. Run a new microphone test to hear them.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start live loopback' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __loopback: { snapshot(): { trackStates: string[] } };
            }
          ).__loopback.snapshot().trackStates,
      ),
    )
    .toEqual(['ended', 'ended', 'ended']);
  await page.evaluate(() =>
    (
      window as unknown as { __loopback: { closeSource(): Promise<void> } }
    ).__loopback.closeSource(),
  );
});

test('live loopback streams continuously through silence, signal changes, and a local microphone replacement', async ({
  page,
}) => {
  await installLoopbackHarness(page);
  await page.addInitScript(() => localStorage.setItem('bc-denoiser', 'off'));
  await openSettings(page);

  await page.getByRole('button', { name: 'Start live loopback' }).click();
  await expect(
    page.getByText('Live loopback · Suppression off · 1-second delay.'),
  ).toBeVisible();

  const rms = () =>
    page.evaluate(() =>
      (window as unknown as { __loopback: { rms(): number } }).__loopback.rms(),
    );
  const setSignal = (frequency: number, gain: number) =>
    page.evaluate(
      ([nextFrequency, nextGain]) =>
        (
          window as unknown as {
            __loopback: { setSignal(frequency: number, gain: number): void };
          }
        ).__loopback.setSignal(nextFrequency, nextGain),
      [frequency, gain] as const,
    );

  await page.waitForTimeout(1_250);
  expect(await rms()).toBeGreaterThan(0.02);
  const sustained = await page.evaluate(() =>
    (
      window as unknown as {
        __loopback: {
          observeRms(
            durationMs: number,
            intervalMs?: number,
          ): Promise<number[]>;
        };
      }
    ).__loopback.observeRms(8_000, 50),
  );
  expect(sustained.length).toBeGreaterThanOrEqual(120);
  expect(Math.min(...sustained)).toBeGreaterThan(0.02);
  await setSignal(880, 0.08);
  await page.waitForTimeout(2_000);
  expect(await rms()).toBeGreaterThan(0.005);
  await setSignal(880, 0);
  await page.waitForTimeout(2_000);
  expect(await rms()).toBeLessThan(0.0001);
  await setSignal(220, 0.2);
  await page.waitForTimeout(2_000);
  expect(await rms()).toBeGreaterThan(0.02);

  await page.evaluate(async () => {
    const harness = (
      window as unknown as {
        __loopback: {
          makeReplacement(
            frequency: number,
            gain: number,
          ): Promise<MediaStreamTrack>;
        };
      }
    ).__loopback;
    const engine = (
      window as unknown as {
        __testEngine: {
          setLocalTrack(
            source: 'microphone',
            track: MediaStreamTrack,
          ): Promise<void>;
          dispatchEvent(event: Event): boolean;
        };
      }
    ).__testEngine;
    await engine.setLocalTrack(
      'microphone',
      await harness.makeReplacement(660, 0.15),
    );
    engine.dispatchEvent(
      new CustomEvent('denoiser-status', {
        detail: {
          requested: 'rnnoise',
          active: 'rnnoise',
          message: 'RNNoise processor recovered.',
        },
      }),
    );
  });
  await expect(
    page.getByText(/Live loopback · RNNoise · 1-second delay/),
  ).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(await rms()).toBeGreaterThan(0.01);
  await page.waitForTimeout(3_000);
  expect(await rms()).toBeGreaterThan(0.01);

  const active = await page.evaluate(() =>
    (
      window as unknown as {
        __loopback: {
          snapshot(): {
            contextStates: string[];
            delayCount: number;
            recorderCount: number;
            trackStates: string[];
          };
        };
      }
    ).__loopback.snapshot(),
  );
  expect(active.contextStates).toEqual(['closed', 'running']);
  expect(active.delayCount).toBe(1);
  expect(active.recorderCount).toBe(0);
  expect(active.trackStates).toEqual(['ended', 'live']);

  await page.getByRole('button', { name: 'Stop live loopback' }).click();
  await expect(page.getByText('Live loopback stopped.')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __loopback: {
              snapshot(): { contextStates: string[]; trackStates: string[] };
            };
          }
        ).__loopback.snapshot(),
      ),
    )
    .toMatchObject({
      contextStates: ['closed', 'closed'],
      trackStates: ['ended', 'ended'],
    });
  await page.evaluate(() =>
    (
      window as unknown as { __loopback: { closeSource(): Promise<void> } }
    ).__loopback.closeSource(),
  );
});

test('navigation cancels pending loopback capture and releases its late track', async ({
  page,
}) => {
  await installLoopbackHarness(page);
  await page.addInitScript(() => localStorage.setItem('bc-denoiser', 'off'));
  await openSettings(page);
  await page.evaluate(() =>
    (
      window as unknown as { __loopback: { setPending(): void } }
    ).__loopback.setPending(),
  );
  await page.getByRole('button', { name: 'Start live loopback' }).click();
  await expect(page.getByText('Starting live loopback…')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/#\/settings$/);
  await page.evaluate(() =>
    (
      window as unknown as { __loopback: { resolvePending(): void } }
    ).__loopback.resolvePending(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __loopback: { snapshot(): { trackStates: string[] } };
            }
          ).__loopback.snapshot().trackStates,
      ),
    )
    .toEqual(['ended']);
  await page.evaluate(() =>
    (
      window as unknown as { __loopback: { closeSource(): Promise<void> } }
    ).__loopback.closeSource(),
  );
});
