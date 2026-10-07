import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const liveAudioTrack = () =>
  ({ kind: 'audio', readyState: 'live' }) as MediaStreamTrack;

test('RNNoise module loads without AudioWorklet and rejects processing before creating resources', async () => {
  const audioContext = vi.fn();
  vi.stubGlobal('AudioContext', audioContext);
  vi.stubGlobal('AudioWorkletNode', undefined);

  const { createDenoiser } = await import('./denoise');

  await expect(createDenoiser(liveAudioTrack())).rejects.toThrow(
    'RNNoise is unavailable because AudioWorklet is not supported',
  );
  expect(audioContext).not.toHaveBeenCalled();
});

test('Speex module loads without AudioWorklet and rejects processing before creating resources', async () => {
  const audioContext = vi.fn();
  vi.stubGlobal('AudioContext', audioContext);
  vi.stubGlobal('AudioWorkletNode', undefined);

  const { createSpeexDenoiser } = await import('./speexDenoise');

  await expect(createSpeexDenoiser(liveAudioTrack())).rejects.toThrow(
    'Speex is unavailable because AudioWorklet is not supported',
  );
  expect(audioContext).not.toHaveBeenCalled();
});
