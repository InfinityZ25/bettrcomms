import { beforeEach, expect, it, vi } from 'vitest';
import { decodeNativeBytes, invokeNativeCapture, onNativeCaptureEnded } from './capture';
const mock = vi.hoisted(() => ({ token: 'fixture', on: vi.fn(), api: {
  NativeScreenSources: vi.fn(), NativeScreenCapabilities: vi.fn(), NativeScreenPeerOffer: vi.fn(), NativeScreenPeerAnswer: vi.fn(),
  NativeSystemAudioStart: vi.fn(), NativeSystemAudioRead: vi.fn(), NativeScreenRecordingRead: vi.fn(), NativeScreenRecordingStop: vi.fn(), NativeScreenThumbnail: vi.fn(),
} }));
vi.mock('./runtime', () => ({ getDesktopRuntime: () => 'wails', readDesktopBootReport: () => ({ pageToken: mock.token }) }));
vi.mock('./wailsbindings/bettercomms/desktop-wails/nativemediaservice', () => mock.api);
vi.mock('@wailsio/runtime', () => ({ Events: { On: mock.on } }));
beforeEach(() => { vi.resetAllMocks(); mock.token = 'fixture'; });

it('normalises empty Go collections for the picker', async () => {
  mock.api.NativeScreenSources.mockResolvedValue(null);
  expect(await invokeNativeCapture('native_screen_sources')).toEqual({ sources: [] });
  mock.api.NativeScreenCapabilities.mockResolvedValue({ available: false, encoders: null });
  expect(await invokeNativeCapture('native_screen_capabilities')).toMatchObject({ encoders: [] });
});

it('adapts offers and answers without losing SDP', async () => {
  mock.api.NativeScreenPeerOffer.mockResolvedValue({ peerId: 'viewer', sdp: 'offer-sdp' });
  expect(await invokeNativeCapture('native_screen_peer_offer', { sessionId: 'capture', peerId: 'viewer', iceServers: [], directOnly: true })).toEqual({ type: 'offer', sdp: 'offer-sdp' });
  await invokeNativeCapture('native_screen_peer_answer', { sessionId: 'capture', peerId: 'viewer', description: { type: 'answer', sdp: 'answer-sdp' } });
  expect(mock.api.NativeScreenPeerAnswer).toHaveBeenCalledWith('fixture', 'capture', 'viewer', 'answer-sdp');
});

it('keeps call audio excluded unless the person explicitly includes it', async () => {
  await invokeNativeCapture('native_system_audio_start');
  expect(mock.api.NativeSystemAudioStart).toHaveBeenLastCalledWith('fixture', { sourceId: '', excludeCallAudio: true });
  await invokeNativeCapture('native_system_audio_start', { sourceId: 'window', excludeCallAudio: false });
  expect(mock.api.NativeSystemAudioStart).toHaveBeenLastCalledWith('fixture', { sourceId: 'window', excludeCallAudio: false });
});

it('decodes recording bytes and supplies the native MP4 container type', async () => {
  mock.api.NativeScreenRecordingRead.mockResolvedValue(btoa(String.fromCharCode(0, 255, 128)));
  const bytes = await invokeNativeCapture<ArrayBuffer>('native_screen_recording_read', { assetId: 'asset', offset: 10, maxBytes: 256 });
  expect([...new Uint8Array(bytes)]).toEqual([0, 255, 128]);
  expect(mock.api.NativeScreenRecordingRead).toHaveBeenCalledWith('fixture', 'asset', 10, 256);
  mock.api.NativeScreenRecordingStop.mockResolvedValue({ assetId: 'asset', sizeBytes: 3 });
  expect(await invokeNativeCapture('native_screen_recording_stop', { recordingId: 'record' })).toMatchObject({ mimeType: 'video/mp4' });
});

it('bounds decoded data and refuses unauthorised thumbnail capture', async () => {
  expect(decodeNativeBytes(null, 8).byteLength).toBe(0);
  expect(() => decodeNativeBytes(btoa('123456789'), 8)).toThrow('limit');
  await expect(invokeNativeCapture('native_screen_recording_read', { assetId: 'asset', offset: -1, maxBytes: 256 })).rejects.toThrow('range');
  mock.token = '';
  await expect(invokeNativeCapture('native_screen_thumbnail', { sourceId: 'screen' })).rejects.toThrow('authorise');
  expect(mock.api.NativeScreenThumbnail).not.toHaveBeenCalled();
});

it('adapts ended events and returns listener disposal', async () => {
  const off = vi.fn(), handler = vi.fn(); mock.on.mockReturnValue(off);
  const dispose = await onNativeCaptureEnded(handler);
  mock.on.mock.calls[0][1]({ data: { sessionId: 'capture', reason: 'source closed' } });
  expect(handler).toHaveBeenCalledWith({ payload: { sessionId: 'capture', reason: 'source closed' } });
  dispose(); expect(off).toHaveBeenCalledOnce();
});
