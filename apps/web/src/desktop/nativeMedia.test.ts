import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveRecordingAsset } from '../media/recordingExport';
import { saveConvertedRecordingAsset } from '../media/nativeRecordingConversion';
import { NativePushToTalk } from '../media/nativePushToTalk';
import { nativeExportCapabilities, startNativeInput } from './nativeMedia';

const mock = vi.hoisted(() => ({
  runtime: 'wails', token: 'test-page-token-not-a-real-secret',
  invoke: vi.fn(), on: vi.fn(), off: vi.fn(),
  api: {
    PushToTalkCapabilities: vi.fn(), PushToTalkStart: vi.fn(), PushToTalkHeartbeat: vi.fn(), PushToTalkStop: vi.fn(),
    RecordingExportBegin: vi.fn(), RecordingConversionBegin: vi.fn(), RecordingExportAppend: vi.fn(),
    RecordingExportFinish: vi.fn(), RecordingExportAbort: vi.fn(), RecordingConversionCapabilities: vi.fn(),
  },
}));
vi.mock('./runtime', () => ({ getDesktopRuntime: () => mock.runtime, readDesktopBootReport: () => ({ pageToken: mock.token }) }));
vi.mock('./wailsbindings/bettercomms/desktop-wails/nativemediaservice', () => mock.api);
vi.mock('@wailsio/runtime', () => ({ Events: { On: mock.on } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));

beforeEach(() => {
  vi.resetAllMocks(); mock.runtime = 'wails'; mock.token = 'test-page-token-not-a-real-secret';
  mock.api.RecordingExportBegin.mockResolvedValue({ exportId: 'export' });
  mock.api.RecordingConversionBegin.mockResolvedValue({ exportId: 'export' });
  mock.api.RecordingExportFinish.mockResolvedValue({ fileName: 'track.wav', path: 'chosen-by-user' });
  mock.api.PushToTalkCapabilities.mockResolvedValue({ available: true, detail: '' });
  mock.api.PushToTalkStart.mockResolvedValue({ sessionId: 'input', sequence: 0, pressed: false, healthy: true, focused: false });
  mock.on.mockReturnValue(mock.off);
});
afterEach(() => vi.useRealTimers());

describe('Wails native exports', () => {
  it('preserves bytes across bounded base64 chunks and authorises every operation', async () => {
    const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => i % 256);
    const progress = vi.fn();
    await saveRecordingAsset({ name: 'track.webm', blob: new Blob([bytes]) }, new AbortController().signal, progress);
    expect(mock.api.RecordingExportBegin).toHaveBeenCalledWith(mock.token, 'track.webm', bytes.length);
    const calls = mock.api.RecordingExportAppend.mock.calls;
    expect(calls).toHaveLength(2);
    const decoded = calls.map(([token, id, offset, chunk], index) => {
      expect(token).toBe(mock.token); expect(id).toBe('export');
      expect(offset).toBe(index * 256 * 1024);
      return Uint8Array.from(atob(chunk), character => character.charCodeAt(0));
    });
    expect(new Uint8Array([...decoded[0], ...decoded[1]])).toEqual(bytes);
    expect(mock.api.RecordingExportFinish).toHaveBeenCalledWith(mock.token, 'export');
    expect(mock.api.RecordingExportAbort).not.toHaveBeenCalled();
    expect(mock.invoke).not.toHaveBeenCalled();
  });

  it('aborts a partially uploaded original when cancellation arrives', async () => {
    const controller = new AbortController();
    mock.api.RecordingExportAppend.mockImplementation(async () => controller.abort());
    await expect(saveRecordingAsset({ name: 'track', blob: new Blob(['abc']) }, controller.signal, () => {})).rejects.toThrow();
    expect(mock.api.RecordingExportAbort).toHaveBeenCalledWith(mock.token, 'export');
    expect(mock.api.RecordingExportFinish).not.toHaveBeenCalled();
  });

  it('treats a dismissed Save As dialog as cancellation without uploading', async () => {
    mock.api.RecordingExportBegin.mockResolvedValue(null);
    expect(await saveRecordingAsset({ name: 'track', blob: new Blob(['abc']) }, new AbortController().signal, () => {})).toBeNull();
    expect(mock.api.RecordingExportAppend).not.toHaveBeenCalled();
  });

  it('commits a converted grant through the Go unified finish method', async () => {
    await saveConvertedRecordingAsset({ name: 'track', blob: new Blob(['abc']) }, 'mp3', new AbortController().signal, () => {});
    expect(mock.api.RecordingConversionBegin).toHaveBeenCalledWith(mock.token, 'track', 3, 'mp3');
    expect(mock.api.RecordingExportFinish).toHaveBeenCalledWith(mock.token, 'export');
  });

  it('derives availability from the Go format probes', async () => {
    mock.api.RecordingConversionCapabilities.mockResolvedValue({ formats: [{ id: 'wav', extension: 'wav', label: 'WAV', available: false }] });
    expect(await nativeExportCapabilities()).toMatchObject({ available: false });
  });

  it('refuses an unauthorised page before opening a native dialog', async () => {
    mock.token = '';
    await expect(saveRecordingAsset({ name: 'track', blob: new Blob(['abc']) }, new AbortController().signal, () => {})).rejects.toThrow('authorise');
    expect(mock.api.RecordingExportBegin).not.toHaveBeenCalled();
  });
});

describe('Wails global input lifecycle', () => {
  it('receives Wails events, rejects stale events and releases the hook on disposal', async () => {
    const pressed = vi.fn();
    const input = new NativePushToTalk(pressed, vi.fn());
    try {
      await input.start({ kind: 'keyboard', code: 'KeyV' });
      expect(mock.api.PushToTalkStart).toHaveBeenCalledWith(mock.token, { kind: 'keyboard', code: 'KeyV' });
      const callback = mock.on.mock.calls[0][1];
      callback({ data: { sessionId: 'input', sequence: 1, pressed: true, healthy: true, focused: false } });
      expect(pressed).toHaveBeenLastCalledWith(true, false);
      callback({ data: { sessionId: 'input', sequence: 0, pressed: false, healthy: true } });
      expect(pressed).toHaveBeenLastCalledWith(true, false);
    } finally { input.dispose(); }
    await vi.waitFor(() => expect(mock.api.PushToTalkStop).toHaveBeenCalledWith(mock.token, 'input'));
    expect(mock.off).toHaveBeenCalledOnce();
    expect(pressed).toHaveBeenLastCalledWith(false);
    expect(mock.invoke).not.toHaveBeenCalled();
  });

  it('refuses native input from a browser or a page without its token', async () => {
    mock.token = '';
    await expect(startNativeInput({ kind: 'mouse', button: 3 })).rejects.toThrow('authorise');
    mock.runtime = 'browser';
    await expect(startNativeInput({ kind: 'mouse', button: 3 })).rejects.toThrow('desktop host');
    expect(mock.api.PushToTalkStart).not.toHaveBeenCalled();
  });
});
