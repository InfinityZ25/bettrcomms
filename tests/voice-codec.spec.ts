import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test('WebCodecs Opus sends 20 ms processed voice and bounds decoder recovery', async ({ page }) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const { createVoiceEncoder, createVoiceDecoder } = await import('/src/media/voiceCodec.ts');
    const sourceContext = new AudioContext({ sampleRate: 48_000 });
    const oscillator = sourceContext.createOscillator();
    const gain = sourceContext.createGain();
    const destination = sourceContext.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    gain.gain.value = 0.12;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await sourceContext.resume();
    const inputTrack = destination.stream.getAudioTracks()[0];
    const errors: string[] = [];
    const packets: Uint8Array[] = [];
    const decoder = await createVoiceDecoder(error => errors.push(String(error)));
    let sequence = 0;
    const encoder = await createVoiceEncoder(
      inputTrack,
      packet => {
        packets.push(packet);
        if (sequence === 12) sequence += 1;
        decoder.push(packet, sequence++);
      },
      error => errors.push(String(error)),
    );
    encoder.setBitrate(48_000);
    const deadline = performance.now() + 3_000;
    while (packets.length < 4 && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    const monitor = new AudioContext({ sampleRate: 48_000 });
    const analyser = monitor.createAnalyser();
    analyser.fftSize = 2048;
    monitor.createMediaStreamSource(decoder.stream).connect(analyser);
    await monitor.resume();
    let rms = 0;
    const samples = new Float32Array(analyser.fftSize);
    const audioDeadline = performance.now() + 2_000;
    while (rms < 0.01 && performance.now() < audioDeadline) {
      analyser.getFloatTimeDomainData(samples);
      rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    let continuityActive = 0;
    for (let index = 0; index < 12; index += 1) {
      analyser.getFloatTimeDomainData(samples);
      const block = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      if (block > 0.01) continuityActive += 1;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    const encodedCount = packets.length;
    inputTrack.enabled = false;
    await new Promise(resolve => setTimeout(resolve, 150));
    const mutedStart = packets.length;
    await new Promise(resolve => setTimeout(resolve, 150));
    const mutedEnd = packets.length;
    const outputTrack = decoder.track;
    encoder.dispose();
    decoder.dispose();
    await new Promise(resolve => setTimeout(resolve, 50));
    const ownership = {
      input: inputTrack.readyState,
      output: outputTrack.readyState,
    };
    inputTrack.stop(); oscillator.stop();
    await Promise.all([sourceContext.close(), monitor.close()]);
    return {
      encodedCount,
      packetBytes: packets.slice(0, 5).map(packet => packet.byteLength),
      rms,
      continuityActive,
      mutedGrowth: mutedEnd - mutedStart,
      errors,
      ownership,
    };
  });
  expect(result.encodedCount).toBeGreaterThanOrEqual(12);
  expect(result.packetBytes.every(bytes => bytes > 0 && bytes < 1_000)).toBe(true);
  expect(result.rms).toBeGreaterThan(0.01);
  expect(result.continuityActive).toBeGreaterThanOrEqual(10);
  expect(result.mutedGrowth).toBeGreaterThan(0);
  expect(result.errors).toEqual([]);
  expect(result.ownership).toEqual({ input: 'live', output: 'ended' });
});

test('unsupported browsers fail explicitly before touching the source track', async ({ page }) => {
  await page.goto(baseURL);
  const message = await page.evaluate(async () => {
    const original = (window as any).AudioEncoder;
    (window as any).AudioEncoder = undefined;
    try {
      const { createVoiceEncoder } = await import(`/src/media/voiceCodec.ts?unsupported=${Date.now()}`);
      return await createVoiceEncoder({} as MediaStreamTrack, () => undefined, () => undefined)
        .then(() => 'unexpected success', error => String(error));
    } finally {
      (window as any).AudioEncoder = original;
    }
  });
  expect(message).toContain('WebCodecs Opus audio is unavailable');
});
