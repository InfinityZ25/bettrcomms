import { chromium, expect, test } from '@playwright/test';

test('primes one shared remote playback graph from a real user gesture', async () => {
  // Launch separately so the suite-wide autoplay bypass cannot mask permission bugs.
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto('http://127.0.0.1:5173');
    await page.setContent('<button id="join">Join</button>');
    await page.evaluate(() => {
      (window as typeof window & { playbackResult?: Promise<unknown> }).playbackResult =
        new Promise((resolve, reject) => {
          document.querySelector('#join')!.addEventListener('click', async () => {
            try {
              const sourceContext = new AudioContext();
              await sourceContext.resume();
              const oscillator = sourceContext.createOscillator();
              const destination = sourceContext.createMediaStreamDestination();
              oscillator.connect(destination);
              oscillator.start();

              const NativeAudioContext = window.AudioContext;
              let playbackContexts = 0;
              let playbackContext: AudioContext | undefined;
              let outputAnalyser: AnalyserNode | undefined;
              window.AudioContext = new Proxy(NativeAudioContext, {
                construct(Target, args) {
                  playbackContexts += 1;
                  const context = Reflect.construct(Target, args) as AudioContext;
                  playbackContext = context;
                  const createLimiter = context.createDynamicsCompressor.bind(context);
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
              window.addEventListener('bc-audio-blocked', () => errors.push('blocked'));
              window.addEventListener('bc-output-error', (event) =>
                errors.push(String((event as CustomEvent).detail)),
              );
              localStorage.setItem('bc-volume-peer', 'not-a-number');
              const audio = await import('/src/media/remoteAudio.ts');
              audio.prepareCallPlayback();
              // Remote tracks commonly arrive after authentication and signaling awaits.
              await new Promise((done) => setTimeout(done, 150));
              const stateBeforeAttachment = playbackContext?.state;
              const track = destination.stream.getAudioTracks()[0];
              const rms = () => {
                const samples = new Float32Array(outputAnalyser!.fftSize);
                outputAnalyser!.getFloatTimeDomainData(samples);
                return Math.sqrt(
                  samples.reduce((sum, sample) => sum + sample * sample, 0) /
                    samples.length,
                );
              };

              const detachSystem = audio.attachRemoteAudio({
                track,
                peerId: 'peer',
                balanceVoice: false,
              });
              await new Promise((done) => setTimeout(done, 150));
              const systemRms = rms();
              detachSystem();

              const detachMicrophone = audio.attachRemoteAudio({
                track,
                peerId: 'peer',
                balanceVoice: true,
              });
              await new Promise((done) => setTimeout(done, 150));
              const microphoneRms = rms();
              detachMicrophone();
              audio.disposeCallPlayback();
              await new Promise((done) => setTimeout(done, 50));
              const result = {
                playbackContexts,
                errors,
                normalizedVolume: audio.readParticipantVolume('peer'),
                stateBeforeAttachment,
                stateAfterDispose: playbackContext?.state,
                systemRms,
                microphoneRms,
              };
              oscillator.stop();
              await sourceContext.close();
              resolve(result);
            } catch (error) {
              reject(error);
            }
          }, { once: true });
        });
    });

    await page.locator('#join').click();
    const result = await page.evaluate(() =>
      (window as typeof window & { playbackResult: Promise<unknown> }).playbackResult,
    );
    expect(result).toMatchObject({
      playbackContexts: 1,
      errors: [],
      normalizedVolume: 1,
      stateBeforeAttachment: 'running',
      stateAfterDispose: 'closed',
    });
    expect((result as { systemRms: number }).systemRms).toBeGreaterThan(0.05);
    expect((result as { microphoneRms: number }).microphoneRms).toBeGreaterThan(0.05);
  } finally {
    await browser.close();
  }
});
