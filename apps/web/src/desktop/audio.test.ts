import { beforeEach, expect, it, vi } from 'vitest';
import { invokeNativeAudio, invokeAudioSetup } from './audio';
const mock = vi.hoisted(() => ({ runtime: 'wails', token: 'fixture', start: vi.fn(), stop: vi.fn(), invoke: vi.fn(), nvidiaStatus: vi.fn(), deepfilterStatus: vi.fn(), nvidiaInstall: vi.fn(), deepfilterInstall: vi.fn() }));
vi.mock('./runtime', () => ({ getDesktopRuntime: () => mock.runtime, readDesktopBootReport: () => ({ pageToken: mock.token }) }));
vi.mock('./wailsbindings/bettercomms/desktop-wails/nativemediaservice', () => ({ AudioStreamStart: mock.start, AudioStreamStop: mock.stop, NvidiaStatus: mock.nvidiaStatus, DeepfilterStatus: mock.deepfilterStatus, NvidiaInstall: mock.nvidiaInstall, DeepfilterInstall: mock.deepfilterInstall }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
beforeEach(() => { vi.resetAllMocks(); mock.runtime = 'wails'; mock.token = 'fixture'; });

it('selects independent native processors and passes their exact tuning', async () => {
  mock.start.mockResolvedValue({ sessionId: 'audio', port: 1234, token: 'stream', frameSamples: 512, sampleRate: 48000 });
  expect(await invokeNativeAudio('nvidia_stream_start', { intensity: .7, vad: true })).toMatchObject({ sessionId: 'audio', sampleRate: 48000 });
  expect(mock.start).toHaveBeenLastCalledWith('fixture', 'nvidia', .7, true, 100);
  await invokeNativeAudio('deepfilter_stream_start', { attenuationDb: 35 });
  expect(mock.start).toHaveBeenLastCalledWith('fixture', 'deepfilter', 1, false, 35);
  expect(mock.invoke).not.toHaveBeenCalled();
});

it('authorises shutdown of the specific worker session', async () => {
  await invokeNativeAudio('deepfilter_stream_stop', { sessionId: 'test-microphone' });
  expect(mock.stop).toHaveBeenCalledWith('fixture', 'test-microphone');
  await expect(invokeNativeAudio('nvidia_stream_stop')).rejects.toThrow('session');
});

it('refuses unauthorised, browser and unknown operations', async () => {
  mock.token = '';
  await expect(invokeNativeAudio('nvidia_stream_start')).rejects.toThrow('authorise');
  mock.token = 'fixture';
  await expect(invokeNativeAudio('shell_exec')).rejects.toThrow('Unsupported');
  mock.runtime = 'browser';
  await expect(invokeNativeAudio('nvidia_stream_start')).rejects.toThrow('desktop');
  expect(mock.start).not.toHaveBeenCalled();
});

it('preserves Tauri stream command arguments', async () => {
  mock.runtime = 'tauri';
  await invokeNativeAudio('nvidia_stream_start', { intensity: .5 });
  expect(mock.invoke).toHaveBeenCalledWith('nvidia_stream_start', { intensity: .5 });
  expect(mock.start).not.toHaveBeenCalled();
});

it('maps readiness from actual GPU probes, not installation presence', async () => {
  mock.nvidiaStatus.mockResolvedValue({ available: false, installed: true, frameSamples: 0, detail: 'GPU unavailable' });
  expect(await invokeAudioSetup('nvidia_status')).toEqual({ ready: false, frameSamples: null, sampleRate: 48000, detail: 'GPU unavailable' });
  expect(mock.nvidiaStatus).toHaveBeenCalledWith('fixture');
  mock.deepfilterStatus.mockResolvedValue({ available: true, installed: true, adapter: 'AMD', detail: 'probed' });
  expect(await invokeAudioSetup('deepfilter_status')).toEqual({ ready: true, frameSamples: 512, sampleRate: 48000, detail: 'probed', adapterName: 'AMD' });
});

it('requires page authorisation for installation and forwards installation errors', async () => {
  await invokeAudioSetup('nvidia_install');
  expect(mock.nvidiaInstall).toHaveBeenCalledWith('fixture');
  mock.deepfilterInstall.mockRejectedValue(new Error('hash verification failed'));
  await expect(invokeAudioSetup('deepfilter_install')).rejects.toThrow('hash verification');
  mock.token = '';
  await expect(invokeAudioSetup('nvidia_install')).rejects.toThrow('authorise');
  expect(mock.nvidiaInstall).toHaveBeenCalledOnce();
});
