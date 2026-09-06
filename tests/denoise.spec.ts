import { expect, test } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

test("RNNoise emits audio and releases only its processed track", async ({ page }) => {
  await page.goto(baseURL);

  const result = await page.evaluate(async () => {
    const importModule = new Function(
      "return import('/src/media/denoise.ts')",
    ) as () => Promise<{
      createDenoiser(
        track: MediaStreamTrack,
      ): Promise<{ track: MediaStreamTrack; dispose(): void }>;
    }>;
    const { createDenoiser } = await importModule();

    const inputContext = new AudioContext({ sampleRate: 48_000 });
    const oscillator = new OscillatorNode(inputContext, {
      frequency: 440,
      type: "sine",
    });
    const inputGain = new GainNode(inputContext, { gain: 0.3 });
    const rawDestination = inputContext.createMediaStreamDestination();
    oscillator.connect(inputGain).connect(rawDestination);
    oscillator.start();
    await inputContext.resume();

    const rawTrack = rawDestination.stream.getAudioTracks()[0];
    if (!rawTrack) throw new Error("synthetic source did not produce an audio track");

    let processed: Awaited<ReturnType<typeof createDenoiser>> | undefined;
    const monitorContext = new AudioContext({ sampleRate: 48_000 });

    try {
      processed = await createDenoiser(rawTrack);
      const stateBeforeDispose = processed.track.readyState;

      const monitorSource = monitorContext.createMediaStreamSource(
        new MediaStream([processed.track]),
      );
      const analyser = new AnalyserNode(monitorContext, {
        fftSize: 2048,
        smoothingTimeConstant: 0,
      });
      const silentSink = monitorContext.createMediaStreamDestination();
      monitorSource.connect(analyser).connect(silentSink);
      await monitorContext.resume();

      const samples = new Float32Array(analyser.fftSize);
      let peakRms = 0;
      const deadline = performance.now() + 4_000;
      while (performance.now() < deadline && peakRms < 0.0001) {
        analyser.getFloatTimeDomainData(samples);
        const squareSum = samples.reduce((sum, sample) => sum + sample * sample, 0);
        peakRms = Math.max(peakRms, Math.sqrt(squareSum / samples.length));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      processed.dispose();
      processed.dispose();

      return {
        outputKind: processed.track.kind,
        outputBeforeDispose: stateBeforeDispose,
        outputAfterDispose: processed.track.readyState,
        rawAfterDispose: rawTrack.readyState,
        peakRms,
      };
    } finally {
      processed?.dispose();
      rawTrack.stop();
      oscillator.stop();
      oscillator.disconnect();
      inputGain.disconnect();
      rawDestination.disconnect();
      await Promise.allSettled([inputContext.close(), monitorContext.close()]);
    }
  });

  expect(result.outputKind).toBe("audio");
  expect(result.outputBeforeDispose).toBe("live");
  expect(result.peakRms).toBeGreaterThan(0.0001);
  expect(result.outputAfterDispose).toBe("ended");
  expect(result.rawAfterDispose).toBe("live");
});
