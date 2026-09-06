import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';

test('element playback follows centralized and per-element volume without altering media', async ({ page }) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const makeWav = () => {
      const sampleRate = 48_000;
      const sampleCount = sampleRate * 2;
      const bytes = new Uint8Array(44 + sampleCount * 2);
      const view = new DataView(bytes.buffer);
      const text = (offset: number, value: string) =>
        [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
      text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE');
      text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
      view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
      view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, sampleCount * 2, true);
      for (let index = 0; index < sampleCount; index += 1)
        view.setInt16(44 + index * 2, Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 12_000, true);
      return bytes;
    };
    const original = makeWav();
    const snapshot = [...original];
    const blob = new Blob([original], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const element = document.createElement('audio');
    element.src = url;
    element.loop = true;
    document.body.append(element);

    const NativeAudioContext = window.AudioContext;
    const contexts: AudioContext[] = [];
    let analyser: AnalyserNode | undefined;
    window.AudioContext = new Proxy(NativeAudioContext, {
      construct(Target, args) {
        const context = Reflect.construct(Target, args) as AudioContext;
        contexts.push(context);
        const createGain = context.createGain.bind(context);
        Object.defineProperty(context, 'createGain', { value: () => {
          const gain = createGain();
          analyser = new AnalyserNode(context, { fftSize: 2048, smoothingTimeConstant: 0 });
          gain.connect(analyser);
          return gain;
        } });
        return context;
      },
    });
    const { followElementOutput } = await import('/src/media/output.ts');
    const { setOutputVolume } = await import('/src/media/volumeSettings.ts');
    const errors: string[] = [];
    setOutputVolume(1);
    const releaseStrictMount = followElementOutput(element, (error) => errors.push(error.message));
    releaseStrictMount();
    const release = followElementOutput(element, (error) => errors.push(error.message));
    await element.play();
    // Wait for the analyser window to contain decoded samples, not startup zeros.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const sample = async () => {
      const values = new Float32Array(analyser!.fftSize);
      let measured = 0;
      const deadline = performance.now() + 2_000;
      while (performance.now() < deadline && measured < 0.0001) {
        analyser!.getFloatTimeDomainData(values);
        measured = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
        if (measured < 0.0001) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return measured;
    };
    const defaultRms = await sample();
    setOutputVolume(2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const doubledRms = await sample();
    element.volume = 0.5;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const halfElementAtDoubleMaster = await sample();
    element.muted = true;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mutedRms = await sample();
    element.muted = false;
    element.volume = 1;
    setOutputVolume(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const zeroMasterRms = await sample();

    const bytesUnchanged = snapshot.every((value, index) => original[index] === value)
      && (await blob.arrayBuffer()).byteLength === original.byteLength;
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const statesAfterCleanup = contexts.map((context) => context.state);
    element.pause(); element.remove(); URL.revokeObjectURL(url);
    return {
      defaultRms, doubledRms, halfElementAtDoubleMaster, mutedRms,
      zeroMasterRms, bytesUnchanged, contextCount: contexts.length,
      statesAfterCleanup, errors,
    };
  });

  expect(result.errors).toEqual([]);
  expect(result.contextCount).toBe(1);
  expect(result.defaultRms).toBeGreaterThan(0.05);
  expect(result.doubledRms / result.defaultRms).toBeGreaterThan(1.8);
  expect(result.doubledRms / result.defaultRms).toBeLessThan(2.2);
  expect(result.halfElementAtDoubleMaster / result.defaultRms).toBeGreaterThan(0.9);
  expect(result.halfElementAtDoubleMaster / result.defaultRms).toBeLessThan(1.1);
  expect(result.mutedRms).toBeLessThan(0.00002);
  expect(result.zeroMasterRms).toBeLessThan(0.00002);
  expect(result.bytesUnchanged).toBe(true);
  expect(result.statesAfterCleanup).toEqual(['closed']);
});
