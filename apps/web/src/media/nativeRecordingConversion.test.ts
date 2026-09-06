import { beforeEach, expect, it, vi } from 'vitest';
import { saveConvertedRecordingAsset } from './nativeRecordingConversion';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), desktop: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => mocks.desktop }));
beforeEach(() => { mocks.invoke.mockReset(); mocks.desktop = true; });

it('uploads the untouched source in bounded chunks and uses a conversion grant', async () => {
  const source = Uint8Array.from({ length: 600_000 }, (_, i) => i % 251);
  const received: number[] = [];
  const progress: (number | null)[] = [];
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'recording_conversion_begin') {
      expect(args).toEqual({ fileName: 'screen.webm', sizeBytes: source.length, format: 'mp4' });
      return { exportId: 'conversion' };
    }
    if (command === 'recording_export_append') {
      expect(args.offset).toBe(received.length);
      expect(args.bytes.length).toBeLessThanOrEqual(256 * 1024);
      for (const byte of args.bytes) received.push(byte);
    }
    if (command === 'recording_conversion_finish') {
      expect(new Uint8Array(received)).toEqual(source);
      return { fileName: 'screen.mp4', path: 'chosen/screen.mp4' };
    }
  });
  const saved = await saveConvertedRecordingAsset({ name: 'screen.webm', blob: new Blob([source]) }, 'mp4', new AbortController().signal, p => progress.push(p));
  expect(saved?.fileName).toBe('screen.mp4');
  expect(progress.at(-1)).toBeNull();
  expect(mocks.invoke.mock.calls.some(([name]) => name === 'recording_export_finish')).toBe(false);
});

it('cancels a running native process immediately rather than waiting for finish', async () => {
  const controller = new AbortController();
  let rejectFinish: (error: Error) => void = () => {};
  mocks.invoke.mockImplementation(async command => {
    if (command === 'recording_conversion_begin') return { exportId: 'running' };
    if (command === 'recording_conversion_finish') {
      return new Promise((_, reject) => {
        rejectFinish = reject;
        queueMicrotask(() => controller.abort());
      });
    }
    if (command === 'recording_export_abort') rejectFinish(new Error('Conversion cancelled'));
  });
  await expect(saveConvertedRecordingAsset({ name: 'mic.webm', blob: new Blob(['source']) }, 'wav', controller.signal, () => {})).rejects.toThrow('cancelled');
  expect(mocks.invoke.mock.calls.some(([name]) => name === 'recording_export_abort')).toBe(true);
});

it('cleans a late Save As grant after navigation', async () => {
  const controller = new AbortController();
  mocks.invoke.mockImplementation(async command => {
    if (command === 'recording_conversion_begin') { controller.abort(); return { exportId: 'late' }; }
  });
  await expect(saveConvertedRecordingAsset({ name: 'mic.webm', blob: new Blob(['source']) }, 'wav', controller.signal, () => {})).rejects.toThrow();
  expect(mocks.invoke.mock.calls.map(([name]) => name)).toEqual(['recording_conversion_begin', 'recording_export_abort']);
});
