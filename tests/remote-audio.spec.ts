import { chromium, expect, test } from '@playwright/test';

test('primes one shared remote playback graph from a real user gesture', async ({
  baseURL,
}) => {
  // Launch separately so the suite-wide autoplay bypass cannot mask permission bugs.
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(baseURL ?? 'http://127.0.0.1:5173');
    await page.setContent('<button id="join">Join</button>');
    await page.evaluate(() => {
      (
        window as typeof window & { playbackResult?: Promise<unknown> }
      ).playbackResult = new Promise((resolve, reject) => {
        document.querySelector('#join')!.addEventListener(
          'click',
          async () => {
            try {
              const sourceContext = new AudioContext();
              await sourceContext.resume();
              const oscillator = sourceContext.createOscillator();
              const sourceAnalyser = sourceContext.createAnalyser();
              sourceAnalyser.fftSize = 1024;
              const destination = sourceContext.createMediaStreamDestination();
              oscillator.connect(sourceAnalyser).connect(destination);
              oscillator.start();

              const NativeAudioContext = window.AudioContext;
              let playbackContexts = 0;
              let playbackContext: AudioContext | undefined;
              let outputAnalyser: AnalyserNode | undefined;
              const rms = (analyser: AnalyserNode | undefined) => {
                if (!analyser) return 0;
                const samples = new Float32Array(analyser.fftSize);
                analyser.getFloatTimeDomainData(samples);
                return Math.sqrt(
                  samples.reduce((sum, sample) => sum + sample * sample, 0) /
                    samples.length,
                );
              };
              const waitForAudio = async (
                ready: () => boolean,
                label: string,
              ) => {
                const deadline = performance.now() + 5_000;
                while (!ready()) {
                  if (performance.now() >= deadline)
                    throw new Error(
                      `${label}: source=${sourceContext.state}/${sourceContext.currentTime}, playback=${playbackContext?.state}/${playbackContext?.currentTime}`,
                    );
                  await new Promise((done) => setTimeout(done, 20));
                }
              };
              window.AudioContext = new Proxy(NativeAudioContext, {
                construct(Target, args) {
                  playbackContexts += 1;
                  const context = Reflect.construct(
                    Target,
                    args,
                  ) as AudioContext;
                  playbackContext = context;
                  const createLimiter =
                    context.createDynamicsCompressor.bind(context);
                  Object.defineProperty(context, 'createDynamicsCompressor', {
                    value: () => {
                      const limiter = createLimiter();
                      outputAnalyser = context.createAnalyser();
                      outputAnalyser.fftSize = 1024;
                      limiter.connect(outputAnalyser);
                      return limiter;
                    },
                  });
                  return context;
                },
              });
              const errors: string[] = [];
              window.addEventListener('bc-audio-blocked', () =>
                errors.push('blocked'),
              );
              window.addEventListener('bc-output-error', (event) =>
                errors.push(String((event as CustomEvent).detail)),
              );
              localStorage.setItem('bc-volume-peer', 'not-a-number');
              const audio = await import('/src/media/remoteAudio.ts');
              audio.prepareCallPlayback();
              // Remote tracks commonly arrive after authentication and signaling awaits.
              // Wait for actual rendering without resuming the playback graph ourselves.
              await waitForAudio(
                () =>
                  sourceContext.currentTime >= 0.15 &&
                  rms(sourceAnalyser) > 0.05 &&
                  playbackContext?.state === 'running' &&
                  playbackContext.currentTime >= 0.15,
                'The user gesture did not start source and playback audio clocks',
              );
              const stateBeforeAttachment = playbackContext?.state;
              const track = destination.stream.getAudioTracks()[0]!;

              const detachSystem = audio.attachRemoteAudio({
                track,
                peerId: 'peer',
                balanceVoice: false,
              });
              const systemStartedAt = playbackContext!.currentTime;
              let systemRms = 0;
              await waitForAudio(() => {
                systemRms = rms(outputAnalyser);
                return (
                  playbackContext!.currentTime - systemStartedAt >= 0.15 &&
                  systemRms > 0.05
                );
              }, 'System audio did not reach the shared output graph');
              detachSystem();

              const detachMicrophone = audio.attachRemoteAudio({
                track,
                peerId: 'peer',
                balanceVoice: true,
              });
              const microphoneStartedAt = playbackContext!.currentTime;
              let microphoneRms = 0;
              await waitForAudio(() => {
                microphoneRms = rms(outputAnalyser);
                return (
                  playbackContext!.currentTime - microphoneStartedAt >= 0.15 &&
                  microphoneRms > 0.05
                );
              }, 'Microphone audio did not reach the shared output graph');
              detachMicrophone();
              audio.disposeCallPlayback();
              await waitForAudio(
                () => playbackContext?.state === 'closed',
                'Playback context did not close',
              );
              const result = {
                playbackContexts,
                errors,
                normalizedVolume: audio.readParticipantVolume('peer'),
                stateBeforeAttachment,
                stateAfterDispose: playbackContext?.state,
                systemRms,
                microphoneRms,
              };
              track.stop();
              oscillator.stop();
              await sourceContext.close();
              window.AudioContext = NativeAudioContext;
              resolve(result);
            } catch (error) {
              reject(error);
            }
          },
          { once: true },
        );
      });
    });

    await page.locator('#join').click();
    const result = await page.evaluate(
      () =>
        (window as typeof window & { playbackResult: Promise<unknown> })
          .playbackResult,
    );
    expect(result).toMatchObject({
      playbackContexts: 1,
      errors: [],
      normalizedVolume: 1,
      stateBeforeAttachment: 'running',
      stateAfterDispose: 'closed',
    });
    expect((result as { systemRms: number }).systemRms).toBeGreaterThan(0.05);
    expect((result as { microphoneRms: number }).microphoneRms).toBeGreaterThan(
      0.05,
    );
  } finally {
    await browser.close();
  }
});
