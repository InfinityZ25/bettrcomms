import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';

test('mono microphone processing preserves either stereo input and plays centered', async ({ page }) => {
  await page.goto(baseURL);
  const results = await page.evaluate(async () => {
    type Processor = 'rnnoise' | 'speex' | 'neutral';
    const inspectStereoPlayback = async (context: AudioContext, node: AudioNode) => {
      const probeName = `channel-probe-${crypto.randomUUID()}`;
      const module = URL.createObjectURL(new Blob([`
        class ChannelProbe extends AudioWorkletProcessor {
          frames = 0;
          leftEnergy = 0;
          rightEnergy = 0;
          samples = 0;
          process(inputs) {
            const input = inputs[0];
            if (input.length < 2) return true;
            let left = 0, right = 0;
            for (let index = 0; index < input[0].length; index += 1) {
              left += input[0][index] * input[0][index];
              right += input[1][index] * input[1][index];
            }
            if (left > 0.000001 && right > 0.000001) {
              this.leftEnergy += left;
              this.rightEnergy += right;
              this.samples += input[0].length;
              this.frames += 1;
              if (this.frames === 8) this.port.postMessage({
                left: Math.sqrt(this.leftEnergy / this.samples),
                right: Math.sqrt(this.rightEnergy / this.samples),
              });
            }
            return true;
          }
        }
        registerProcessor('${probeName}', ChannelProbe);
      `], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(module);
      } finally {
        URL.revokeObjectURL(module);
      }
      const upmix = new GainNode(context, {
        gain: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      const probe = new AudioWorkletNode(context, probeName, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      const silent = new GainNode(context, { gain: 0 });
      node.connect(upmix).connect(probe).connect(silent).connect(context.destination);
      const pair = await new Promise<{ left: number; right: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out sampling stereo playback')), 4_000);
        probe.port.onmessage = ({ data }) => {
          clearTimeout(timer);
          resolve(data as { left: number; right: number });
        };
      });
      return { ...pair, disconnect: () => {
        probe.port.onmessage = null;
        node.disconnect(); upmix.disconnect(); probe.disconnect();
        silent.disconnect();
      } };
    };

    const run = async (processor: Processor, side: 'left' | 'right') => {
      const input = new AudioContext({ sampleRate: 48_000 });
      const oscillator = new OscillatorNode(input, { frequency: side === 'left' ? 523 : 659 });
      const level = new GainNode(input, { gain: 0.3 });
      const merger = input.createChannelMerger(2);
      const destination = input.createMediaStreamDestination();
      destination.channelCount = 2;
      oscillator.connect(level).connect(merger, 0, side === 'left' ? 0 : 1);
      merger.connect(destination);
      oscillator.start();
      await input.resume();
      const raw = destination.stream.getAudioTracks()[0]!;
      const nativeGetSettings = raw.getSettings.bind(raw);
      Object.defineProperty(raw, 'getSettings', {
        configurable: true,
        value: () => ({ ...nativeGetSettings(), channelCount: 2 }),
      });

      let processed: { track: MediaStreamTrack; dispose(): void };
      if (processor === 'rnnoise') {
        const { createDenoiser } = await import('/src/media/denoise.ts');
        processed = await createDenoiser(raw);
      } else if (processor === 'speex') {
        const { createSpeexDenoiser } = await import('/src/media/speexDenoise.ts');
        processed = await createSpeexDenoiser(raw);
      } else {
        const { createMicrophoneEffects } = await import('/src/media/microphoneEffects.ts');
        processed = await createMicrophoneEffects(raw, {
          highPassHz: 0, gainDb: 0, gateEnabled: false,
        } as never);
      }

      const monitor = new AudioContext({ sampleRate: 48_000 });
      await monitor.resume();
      const liveNode = monitor.createMediaStreamSource(new MediaStream([processed.track]));
      const live = await inspectStereoPlayback(monitor, liveNode);
      live.disconnect();

      const chunks: Blob[] = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(new MediaStream([processed.track]), { mimeType });
      recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
      const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
      recorder.start(100);
      await new Promise((resolve) => setTimeout(resolve, 900));
      recorder.stop();
      await stopped;
      const blob = new Blob(chunks, { type: recorder.mimeType });

      const element = document.createElement('audio');
      const url = URL.createObjectURL(blob);
      element.src = url;
      const decodedNode = monitor.createMediaElementSource(element);
      const decodedPromise = inspectStereoPlayback(monitor, decodedNode);
      await element.play();
      const decoded = await decodedPromise;
      decoded.disconnect();
      element.pause();
      URL.revokeObjectURL(url);

      const outputChannels = processed.track.getSettings().channelCount;
      processed.dispose();
      raw.stop();
      oscillator.stop();
      await Promise.allSettled([input.close(), monitor.close()]);
      return {
        processor, side, outputChannels, liveLeft: live.left, liveRight: live.right,
        decodedLeft: decoded.left, decodedRight: decoded.right, assetBytes: blob.size,
      };
    };

    const values = [];
    for (const processor of ['rnnoise', 'speex', 'neutral'] as const)
      for (const side of ['left', 'right'] as const) values.push(await run(processor, side));
    return values;
  });

  for (const result of results) {
    expect(result.outputChannels, `${result.processor} ${result.side} output channels`).toBe(1);
    expect(result.liveLeft, `${result.processor} ${result.side} live left`).toBeGreaterThan(0.0002);
    expect(result.liveRight, `${result.processor} ${result.side} live right`).toBeGreaterThan(0.0002);
    expect(result.liveLeft / result.liveRight).toBeGreaterThan(0.9);
    expect(result.liveLeft / result.liveRight).toBeLessThan(1.1);
    expect(result.assetBytes, `${result.processor} ${result.side} recording`).toBeGreaterThan(1_000);
    expect(result.decodedLeft, `${result.processor} ${result.side} decoded left`).toBeGreaterThan(0.0002);
    expect(result.decodedRight, `${result.processor} ${result.side} decoded right`).toBeGreaterThan(0.0002);
    expect(result.decodedLeft / result.decodedRight).toBeGreaterThan(0.9);
    expect(result.decodedLeft / result.decodedRight).toBeLessThan(1.1);
  }
});
