import { beforeEach, expect, it, vi } from 'vitest';
import { saveRecordingAsset } from './recordingExport';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), desktop: true }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  isTauri: () => mocks.desktop,
}));
beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.desktop = true;
});

it('writes unchanged original bytes in ordered bounded chunks and commits only after all bytes', async () => {
  const bytes = Uint8Array.from(
    { length: 600 * 1024 + 31 },
    (_, index) => index % 251,
  );
  const received: number[] = [];
  const progress: number[] = [];
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'recording_export_begin') {
      expect(args).toEqual({
        fileName: 'original.webm',
        sizeBytes: bytes.length,
      });
      return { exportId: 'grant' };
    }
    if (command === 'recording_export_append') {
      expect(args.offset).toBe(received.length);
      expect(args.bytes.length).toBeLessThanOrEqual(256 * 1024);
      for (const byte of args.bytes) received.push(byte);
    }
    if (command === 'recording_export_finish') {
      expect(Uint8Array.from(received)).toEqual(bytes);
      return { fileName: 'original.webm', path: 'chosen/original.webm' };
    }
  });
  const saved = await saveRecordingAsset(
    { name: 'original.webm', blob: new Blob([bytes]) },
    new AbortController().signal,
    (p) => progress.push(p),
  );
  expect(saved?.path).toBe('chosen/original.webm');
  expect(progress.at(-1)).toBe(1);
  expect(
    mocks.invoke.mock.calls.filter(
      ([cmd]) => cmd === 'recording_export_append',
    ),
  ).toHaveLength(3);
  expect(
    mocks.invoke.mock.calls.some(([cmd]) => cmd === 'recording_export_abort'),
  ).toBe(false);
});

it('cancelling Save As produces no writes or success claim', async () => {
  mocks.invoke.mockResolvedValue(null);
  expect(
    await saveRecordingAsset(
      { name: 'a.webm', blob: new Blob(['data']) },
      new AbortController().signal,
      () => {},
    ),
  ).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it('aborts a late grant if navigation happened while Save As was open', async () => {
  const controller = new AbortController();
  mocks.invoke.mockImplementation(async (command) => {
    if (command === 'recording_export_begin') {
      controller.abort();
      return { exportId: 'late' };
    }
  });
  await expect(
    saveRecordingAsset(
      { name: 'a.webm', blob: new Blob(['data']) },
      controller.signal,
      () => {},
    ),
  ).rejects.toThrow();
  expect(mocks.invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
    'recording_export_begin',
    'recording_export_abort',
  ]);
});

it('revokes unfinished exports on disk errors and never commits partial data', async () => {
  mocks.invoke.mockImplementation(async (command) => {
    if (command === 'recording_export_begin') return { exportId: 'full-disk' };
    if (command === 'recording_export_append') throw new Error('disk full');
  });
  await expect(
    saveRecordingAsset(
      { name: 'a.webm', blob: new Blob(['data']) },
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow('disk full');
  expect(mocks.invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
    'recording_export_begin',
    'recording_export_append',
    'recording_export_abort',
  ]);
});

it('does not invoke native commands in a browser', async () => {
  mocks.desktop = false;
  await expect(
    saveRecordingAsset(
      { name: 'a.webm', blob: new Blob(['data']) },
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow('desktop');
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('explains when the running desktop host predates native recording export', async () => {
  mocks.invoke.mockRejectedValue(
    new Error('Command recording_export_begin not found'),
  );
  await expect(
    saveRecordingAsset(
      { name: 'a.webm', blob: new Blob(['data']) },
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow('outdated native host');
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
