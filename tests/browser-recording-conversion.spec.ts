import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';

test('converts a real WebM recording to playable H264 MP4 and PCM WAV locally', async ({ page }) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const graphics = canvas.getContext('2d')!;
    let frame = 0;
    const paint = () => {
      graphics.fillStyle = frame++ % 2 ? '#6ee7b7' : '#312e81';
      graphics.fillRect(0, 0, canvas.width, canvas.height);
      graphics.fillStyle = 'white'; graphics.font = '28px sans-serif';
      graphics.fillText('Local recording', 42, 100);
    };
    paint();
    const paintTimer = setInterval(paint, 50);
    const stream = canvas.captureStream(20);
    const audioContext = new AudioContext({ sampleRate: 48_000 });
    const oscillator = new OscillatorNode(audioContext, { frequency: 440 });
    const gain = new GainNode(audioContext, { gain: 0.15 });
    const audioDestination = audioContext.createMediaStreamDestination();
    oscillator.connect(gain).connect(audioDestination);
    oscillator.start(); await audioContext.resume();
    stream.addTrack(audioDestination.stream.getAudioTracks()[0]!);
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported(type))!;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
    const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
    recorder.start(100); await new Promise((resolve) => setTimeout(resolve, 1_250)); recorder.stop(); await stopped;
    clearInterval(paintTimer); oscillator.stop(); stream.getTracks().forEach((track) => track.stop()); await audioContext.close();
    const source = new Blob(chunks, { type: recorder.mimeType });
    const hash = async (blob: Blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    const beforeHash = await hash(source);
    const { convertBrowserRecording } = await import('/src/media/browserRecordingConversion.ts');
    const [avcSupport, aacSupport] = await Promise.all([
      typeof VideoEncoder === 'undefined' ? false : VideoEncoder.isConfigSupported({
        codec: 'avc1.42001e', width: 320, height: 180, bitrate: 1_000_000, framerate: 20,
      }).then(({ supported }) => supported).catch(() => false),
      typeof AudioEncoder === 'undefined' ? false : AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 1, bitrate: 128_000,
      }).then(({ supported }) => supported).catch(() => false),
    ]);
    const mp4Progress: number[] = [], wavProgress: number[] = [];
    const wav = await convertBrowserRecording({ name: 'sample.webm', blob: source }, 'wav', undefined, (value) => wavProgress.push(value));
    let mp4: Awaited<ReturnType<typeof convertBrowserRecording>> | undefined;
    let mp4Error = '';
    try {
      mp4 = await convertBrowserRecording({ name: 'sample.webm', blob: source }, 'mp4', undefined, (value) => mp4Progress.push(value));
    } catch (error) {
      mp4Error = (error as Error).message;
    }
    const afterHash = await hash(source);

    const inspectElement = (element: HTMLMediaElement, blob: Blob) => new Promise<{ duration: number; width?: number; height?: number }>((resolve, reject) => {
      const url = URL.createObjectURL(blob); element.src = url;
      element.onloadeddata = async () => {
        try {
          if (element instanceof HTMLVideoElement) {
            element.muted = true;
            await element.play();
            await new Promise<void>((frameResolve, frameReject) => {
              const timer = setTimeout(() => frameReject(new Error('No decoded video frame')), 3_000);
              element.requestVideoFrameCallback(() => { clearTimeout(timer); frameResolve(); });
            });
          }
          resolve({ duration: element.duration, ...('videoWidth' in element ? {
            width: (element as HTMLVideoElement).videoWidth, height: (element as HTMLVideoElement).videoHeight,
          } : {}) });
        } catch (error) { reject(error); }
        finally { element.pause(); URL.revokeObjectURL(url); }
      };
      element.onerror = () => reject(new Error('Converted media did not load'));
    });
    const wavMedia = await inspectElement(document.createElement('audio'), wav.blob);
    const mp4Media = mp4 ? await inspectElement(document.createElement('video'), mp4.blob) : undefined;
    const mp4Bytes = mp4 ? new Uint8Array(await mp4.blob.arrayBuffer()) : new Uint8Array();
    const mp4Text = new TextDecoder('latin1').decode(mp4Bytes);
    const wavBytes = await wav.blob.arrayBuffer();
    const wavHeader = new DataView(wavBytes);
    const videoCodec = mp4Text.includes('avc1') ? 'avc' : 'unknown';
    const mp4AudioCodec = mp4Text.includes('mp4a') ? 'aac' : 'unknown';
    const audioCodec = wavHeader.getUint16(20, true) === 1 ? 'pcm-s16' : 'unknown';
    const decodeEnergy = async (blob: Blob) => {
      const context = new AudioContext();
      try {
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        let sum = 0; let count = 0;
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
          const samples = decoded.getChannelData(channel);
          for (let index = 0; index < samples.length; index += 32) { sum += samples[index]! ** 2; count++; }
        }
        return Math.sqrt(sum / Math.max(1, count));
      } finally { await context.close(); }
    };
    const wavEnergy = await decodeEnergy(wav.blob);
    const mp4Energy = mp4 ? await decodeEnergy(mp4.blob) : 0;
    return {
      sourceBytes: source.size, beforeHash, afterHash,
      encoderSupport: avcSupport && aacSupport,
      mp4: mp4 ? { name: mp4.name, type: mp4.blob.type, bytes: mp4.blob.size, ...mp4Media, videoCodec, audioCodec: mp4AudioCodec, energy: mp4Energy } : undefined,
      mp4Error,
      wav: { name: wav.name, type: wav.blob.type, bytes: wav.blob.size, ...wavMedia, audioCodec, energy: wavEnergy },
      mp4Progress, wavProgress,
    };
  });

  expect(result.sourceBytes).toBeGreaterThan(1_000);
  expect(result.afterHash).toBe(result.beforeHash);
  if (result.mp4) {
    expect(result.mp4).toMatchObject({ name: 'sample.mp4', type: 'video/mp4', width: 320, height: 180, videoCodec: 'avc', audioCodec: 'aac' });
    expect(result.mp4.bytes).toBeGreaterThan(1_000);
    expect(result.mp4.duration).toBeGreaterThan(0.8);
    expect(result.mp4.energy).toBeGreaterThan(0.01);
    expect(result.mp4Progress[0]).toBe(0);
    expect(result.mp4Progress.at(-1)).toBe(1);
  } else {
    expect(result.encoderSupport).toBe(false);
    expect(result.mp4Error).toMatch(/cannot convert|WebCodecs|encode|codec/i);
  }
  expect(result.wav).toMatchObject({ name: 'sample.wav', type: 'audio/wav', audioCodec: 'pcm-s16' });
  expect(result.wav.bytes).toBeGreaterThan(40_000);
  expect(result.wav.duration).toBeGreaterThan(0.8);
  expect(result.wav.energy).toBeGreaterThan(0.01);
  for (const progress of [result.wavProgress]) {
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  }
});

test('rejects cancellation and unsupported or oversized conversions clearly', async ({ page }) => {
  await page.goto(baseURL);
  const messages = await page.evaluate(async () => {
    const { convertBrowserRecording } = await import('/src/media/browserRecordingConversion.ts');
    const aborted = new AbortController(); aborted.abort();
    const capture = async (operation: () => Promise<unknown>) => {
      try { await operation(); return ''; } catch (error) { return `${(error as Error).name}: ${(error as Error).message}`; }
    };
    const tiny = new Blob([new Uint8Array(32)], { type: 'video/webm' });
    const canceled = await capture(() => convertBrowserRecording({ name: 'x.webm', blob: tiny }, 'mp4', aborted.signal));
    const nativeEncoder = window.VideoEncoder;
    Object.defineProperty(window, 'VideoEncoder', { configurable: true, value: undefined });
    const unsupported = await capture(() => convertBrowserRecording({ name: 'x.webm', blob: tiny }, 'mp4'));
    Object.defineProperty(window, 'VideoEncoder', { configurable: true, value: nativeEncoder });
    const oversized = await capture(() => convertBrowserRecording({
      name: 'large.webm', blob: { size: 512 * 1024 * 1024 + 1 } as Blob,
    }, 'wav'));
    return { canceled, unsupported, oversized };
  });
  expect(messages.canceled).toContain('AbortError');
  expect(messages.unsupported).toContain('WebCodecs video encoding');
  expect(messages.oversized).toContain('512 MiB');
});
