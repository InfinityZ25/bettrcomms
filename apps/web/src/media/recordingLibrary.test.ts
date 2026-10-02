import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecordingResult } from './types';

const activity = vi.hoisted(() => ({ begin: vi.fn(), release: vi.fn() }));
vi.mock('../desktop/desktopSettings', () => ({ beginDesktopActivity: activity.begin }));
beforeEach(() => {
  vi.resetModules();
  activity.begin.mockReset().mockReturnValue(activity.release);
  activity.release.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

it.each(['commit', 'abort'])('holds the desktop activity lease until the recording transaction ends (%s)', async outcome => {
  const put = vi.fn();
  const transaction = {
    oncomplete: undefined as (() => void) | undefined,
    onabort: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
    error: null as Error | null,
    abort: vi.fn(),
    objectStore: () => ({
      put, delete: vi.fn(),
      index: () => ({ getAllKeys: () => {
        const request = { result: [], onsuccess: undefined as (() => void) | undefined };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      } }),
    }),
  };
  vi.stubGlobal('indexedDB', { open: () => {
    const request = { result: { transaction: () => transaction }, onsuccess: undefined as (() => void) | undefined };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } });
  vi.stubGlobal('IDBKeyRange', { only: (value: unknown) => value });
  const result: RecordingResult = {
    manifest: { version: 1, recordingId: 'recording-id', startedAt: '2026-10-02T12:00:00Z', stoppedAt: '2026-10-02T12:00:01Z', tracks: [], replay: { status: 'unsupported' } },
    files: [],
  };
  const { saveRecording } = await import('./recordingLibrary');
  const saving = saveRecording(result, { title: 'Call recording', labels: {} });
  expect(activity.begin).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
  // The recording has stopped, but its IndexedDB transaction is still pending.
  expect(activity.release).not.toHaveBeenCalled();
  if (outcome === 'commit') {
    transaction.oncomplete?.();
    await expect(saving).resolves.toMatchObject({ id: 'recording-id' });
  } else {
    const failure = expect(saving).rejects.toThrow('disk quota');
    transaction.error = new Error('disk quota');
    transaction.onabort?.();
    await failure;
  }
  expect(activity.release).toHaveBeenCalledOnce();
});
