import { expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../desktop/runtime', () => ({
  readDesktopBootReport: () => ({ platform: 'ios' }),
}));
vi.mock('./microphoneEffects', () => ({
  createMicrophoneEffects: effects.create,
}));
vi.mock('./denoise', () => ({ createDenoiser: vi.fn() }));
vi.mock('./speexDenoise', () => ({ createSpeexDenoiser: vi.fn() }));
vi.mock('./nvidiaDenoise', () => ({ createNvidiaDenoiser: vi.fn() }));
vi.mock('./deepfilterDenoise', () => ({ createDeepfilterDenoiser: vi.fn() }));
vi.mock('./deepfilterWasmDenoise', () => ({ createDeepfilterWasmDenoiser: vi.fn() }));
vi.mock('./nativeSystemAudio', () => ({ createNativeSystemAudio: vi.fn() }));
vi.mock('./nativeScreen', () => ({
  NativeScreenTransport: class {
    dispose() {}
  },
}));

import { MediaEngine } from './engine';

it('publishes the captured iPhone microphone without a Web Audio destination', async () => {
  const track = {
    kind: 'audio',
    readyState: 'live',
    enabled: true,
    stop: vi.fn(),
    addEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
  const getUserMedia = vi.fn(async () => ({
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
    getTracks: () => [track],
  }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const engine = new MediaEngine({
    signaling: { localPeerId: 'iphone', send: vi.fn(async () => {}) },
  });

  await engine.captureUserMedia({ camera: false });

  expect(engine.getLocalTracks().get('microphone')).toBe(track);
  expect(effects.create).not.toHaveBeenCalled();
  expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
    audio: expect.objectContaining({ noiseSuppression: true }),
  }));

  engine.dispose();
  expect(track.stop).toHaveBeenCalled();
  vi.unstubAllGlobals();
});
