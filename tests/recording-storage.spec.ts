import { expect, test, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const libraryUrl = '/src/media/recordingLibrary.ts';
const databaseName = 'bettercomms-recordings';

async function clearRecordingDatabase(page: Page): Promise<void> {
  await page.evaluate(async (name) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`Database ${name} is blocked`));
    });
  }, databaseName);
}

test('stores, replaces, renames, and deletes recordings atomically', async ({ page }) => {
  await page.goto('/');
  await clearRecordingDatabase(page);

  const result = await page.evaluate(async (moduleUrl) => {
    const library = await import(moduleUrl);
    const makeResult = (fileNames: string[], values: number[]) => ({
      manifest: {
        version: 1 as const,
        recordingId: 'storage-integration-recording',
        startedAt: '2026-09-05T12:00:00.000Z',
        stoppedAt: '2026-09-05T12:00:02.500Z',
        tracks: fileNames.map((fileName, index) => ({
          id: `track-${index}`,
          peerId: 'synthetic-peer',
          source: 'microphone' as const,
          mediaKind: 'audio' as const,
          mimeType: 'application/octet-stream',
          fileName,
          startedOffsetMs: 0,
          durationMs: 2500,
          bytes: 1,
          status: 'complete' as const,
          endedReason: 'session-stopped' as const,
        })),
        replay: { status: 'unsupported' as const, reason: 'Synthetic test recording' },
      },
      files: fileNames.map((name, index) => ({
        name,
        blob: new Blob([new Uint8Array([values[index]])], { type: 'application/octet-stream' }),
      })),
    });

    const original = makeResult(['first.bin', 'stale.bin'], [11, 22]);
    const saved = await library.saveRecording(original, {
      title: 'Original title',
      labels: { source: 'synthetic' },
    });
    const initiallyLoaded = await library.loadRecording(saved.id);

    const replacement = makeResult(['replacement.bin'], [33]);
    await library.saveRecording(replacement, {
      title: 'Replacement title',
      labels: { source: 'synthetic', revision: '2' },
    });
    const replaced = await library.loadRecording(saved.id);
    await library.renameRecording(saved.id, 'Renamed recording');
    const renamed = await library.loadRecording(saved.id);

    const storeCountsBeforeDelete = await new Promise<{ metadata: number; blobs: number }>((resolve, reject) => {
      const open = indexedDB.open('bettercomms-recordings', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction(['recordings', 'recordingFiles'], 'readonly');
        const metadata = transaction.objectStore('recordings').count(saved.id);
        const blobs = transaction.objectStore('recordingFiles').index('recordingId').count(saved.id);
        transaction.oncomplete = () => {
          resolve({ metadata: metadata.result, blobs: blobs.result });
          database.close();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });

    await library.deleteRecording(saved.id);
    const listedAfterDelete = await library.listRecordings();
    const storeCountsAfterDelete = await new Promise<{ metadata: number; blobs: number }>((resolve, reject) => {
      const open = indexedDB.open('bettercomms-recordings', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction(['recordings', 'recordingFiles'], 'readonly');
        const metadata = transaction.objectStore('recordings').count(saved.id);
        const blobs = transaction.objectStore('recordingFiles').index('recordingId').count(saved.id);
        transaction.oncomplete = () => {
          resolve({ metadata: metadata.result, blobs: blobs.result });
          database.close();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });

    return {
      initiallyLoadedNames: initiallyLoaded.result.files.map((file: { name: string }) => file.name),
      initiallyLoadedBytes: await Promise.all(
        initiallyLoaded.result.files.map(async (file: { blob: Blob }) => [...new Uint8Array(await file.blob.arrayBuffer())]),
      ),
      replacementNames: replaced.result.files.map((file: { name: string }) => file.name),
      replacementBytes: await Promise.all(
        replaced.result.files.map(async (file: { blob: Blob }) => [...new Uint8Array(await file.blob.arrayBuffer())]),
      ),
      renamedTitle: renamed.summary.title,
      manifestId: renamed.result.manifest.recordingId,
      storeCountsBeforeDelete,
      storeCountsAfterDelete,
      listedAfterDelete,
    };
  }, libraryUrl);

  expect(result.initiallyLoadedNames).toEqual(['first.bin', 'stale.bin']);
  expect(result.initiallyLoadedBytes).toEqual([[11], [22]]);
  expect(result.replacementNames).toEqual(['replacement.bin']);
  expect(result.replacementBytes).toEqual([[33]]);
  expect(result.renamedTitle).toBe('Renamed recording');
  expect(result.manifestId).toBe('storage-integration-recording');
  expect(result.storeCountsBeforeDelete).toEqual({ metadata: 1, blobs: 1 });
  expect(result.storeCountsAfterDelete).toEqual({ metadata: 0, blobs: 0 });
  expect(result.listedAfterDelete).toEqual([]);
});

test('quota failures roll back the entire replacement', async ({ page }) => {
  await page.goto('/');
  await clearRecordingDatabase(page);

  const result = await page.evaluate(async (moduleUrl) => {
    const library = await import(moduleUrl);
    const makeResult = (name: string, value: number) => ({
      manifest: {
        version: 1 as const,
        recordingId: 'quota-rollback-recording',
        startedAt: '2026-09-05T12:00:00.000Z',
        stoppedAt: '2026-09-05T12:00:01.000Z',
        tracks: [],
        replay: { status: 'unsupported' as const, reason: 'Synthetic test recording' },
      },
      files: [{ name, blob: new Blob([new Uint8Array([value])]) }],
    });

    await library.saveRecording(makeResult('original.bin', 44), {
      title: 'Original',
      labels: { revision: '1' },
    });

    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'recordingFiles') throw new DOMException('', 'QuotaExceededError');
      return originalPut.apply(this, args);
    };

    let message = '';
    try {
      await library.saveRecording(makeResult('replacement.bin', 55), {
        title: 'Replacement',
        labels: { revision: '2' },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }

    const loaded = await library.loadRecording('quota-rollback-recording');
    return {
      message,
      title: loaded.summary.title,
      labels: loaded.summary.labels,
      names: loaded.result.files.map((file: { name: string }) => file.name),
      bytes: await Promise.all(
        loaded.result.files.map(async (file: { blob: Blob }) => [...new Uint8Array(await file.blob.arrayBuffer())]),
      ),
    };
  }, libraryUrl);

  expect(result.message).toContain('not enough local storage');
  expect(result.title).toBe('Original');
  expect(result.labels).toEqual({ revision: '1' });
  expect(result.names).toEqual(['original.bin']);
  expect(result.bytes).toEqual([[44]]);
});

test('recordings survive a persistent Chromium profile restart', async ({}, testInfo) => {
  const profileDirectory = await mkdtemp(join(tmpdir(), 'bettercomms-recordings-'));
  const baseURL = String(testInfo.project.use.baseURL);
  let firstContext: BrowserContext | undefined;
  let secondContext: BrowserContext | undefined;

  try {
    firstContext = await chromium.launchPersistentContext(profileDirectory, { headless: true, baseURL });
    const firstPage = firstContext.pages()[0] ?? await firstContext.newPage();
    await firstPage.goto('/');
    await clearRecordingDatabase(firstPage);
    await firstPage.evaluate(async (moduleUrl) => {
      const library = await import(moduleUrl);
      await library.saveRecording({
        manifest: {
          version: 1,
          recordingId: 'restart-recording',
          startedAt: '2026-09-05T12:00:00.000Z',
          stoppedAt: '2026-09-05T12:00:03.000Z',
          tracks: [],
          replay: { status: 'unsupported', reason: 'Synthetic test recording' },
        },
        files: [{ name: 'restart.bin', blob: new Blob([new Uint8Array([77, 88, 99])]) }],
      }, { title: 'Restart test', labels: { source: 'synthetic' } });
    }, libraryUrl);
    await firstContext.close();
    firstContext = undefined;

    secondContext = await chromium.launchPersistentContext(profileDirectory, { headless: true, baseURL });
    const secondPage = secondContext.pages()[0] ?? await secondContext.newPage();
    await secondPage.goto('/');
    const restored = await secondPage.evaluate(async (moduleUrl) => {
      const library = await import(moduleUrl);
      const loaded = await library.loadRecording('restart-recording');
      return {
        title: loaded.summary.title,
        names: loaded.result.files.map((file: { name: string }) => file.name),
        bytes: await Promise.all(
          loaded.result.files.map(async (file: { blob: Blob }) => [...new Uint8Array(await file.blob.arrayBuffer())]),
        ),
      };
    }, libraryUrl);
    await secondContext.close();
    secondContext = undefined;

    expect(restored).toEqual({
      title: 'Restart test',
      names: ['restart.bin'],
      bytes: [[77, 88, 99]],
    });
  } finally {
    await Promise.allSettled([firstContext?.close(), secondContext?.close()]);

    const resolvedProfile = resolve(profileDirectory);
    const resolvedTemp = resolve(tmpdir());
    const profileName = basename(resolvedProfile);
    const expectedPrefix = 'bettercomms-recordings-';
    if (
      dirname(resolvedProfile) !== resolvedTemp
      || !profileName.startsWith(expectedPrefix)
      || profileName.length === expectedPrefix.length
    ) {
      throw new Error(`Refusing to remove unexpected persistent profile path: ${resolvedProfile}`);
    }
    await rm(resolvedProfile, { recursive: true, force: true });
  }
});
