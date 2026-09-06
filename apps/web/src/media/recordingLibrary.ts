import type { RecordingManifest, RecordingResult } from './types';

export interface SavedRecording {
  id: string;
  title: string;
  labels: Record<string, string>;
  startedAt: string;
  durationMs: number;
  bytes: number;
  trackCount: number;
}

interface StoredFile {
  key: string;
  recordingId: string;
  position: number;
  name: string;
  blob: Blob;
}

const DATABASE_NAME = 'bettercomms-recordings';
const DATABASE_VERSION = 1;
const METADATA_STORE = 'recordings';
const MANIFEST_STORE = 'recordingManifests';
const FILE_STORE = 'recordingFiles';
const RECORDING_INDEX = 'recordingId';
const CHANGED_EVENT = 'bc-recordings-changed';

let databasePromise: Promise<IDBDatabase> | undefined;

export async function saveRecording(
  result: RecordingResult,
  metadata: { title: string; labels: Record<string, string> },
): Promise<SavedRecording> {
  const summary = summarize(result, metadata);
  await requestPersistentStorage();

  const database = await openDatabase();
  const transaction = database.transaction(
    [METADATA_STORE, MANIFEST_STORE, FILE_STORE],
    'readwrite',
  );
  const completed = transactionComplete(transaction);

  try {
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const manifestStore = transaction.objectStore(MANIFEST_STORE);
    const fileStore = transaction.objectStore(FILE_STORE);
    const oldFileKeys = await request(
      fileStore.index(RECORDING_INDEX).getAllKeys(IDBKeyRange.only(summary.id)),
    );

    for (const key of oldFileKeys) fileStore.delete(key);
    metadataStore.put(summary);
    manifestStore.put({ recordingId: summary.id, manifest: result.manifest });
    result.files.forEach((file, position) => {
      const stored: StoredFile = {
        key: `${summary.id}:${position}`,
        recordingId: summary.id,
        position,
        name: file.name,
        blob: file.blob,
      };
      fileStore.put(stored);
    });

    await completed;
  } catch (error) {
    safelyAbort(transaction);
    await completed.catch(() => undefined);
    throw storageError(error, 'save this recording');
  }

  dispatchChanged();
  return summary;
}

export async function listRecordings(): Promise<SavedRecording[]> {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, 'readonly');
  const summaries = await request<SavedRecording[]>(
    transaction.objectStore(METADATA_STORE).getAll(),
  );
  await transactionComplete(transaction);
  return summaries.sort((left, right) => {
    const byDate = Date.parse(right.startedAt) - Date.parse(left.startedAt);
    return byDate || right.id.localeCompare(left.id);
  });
}

export async function loadRecording(
  id: string,
): Promise<{ summary: SavedRecording; result: RecordingResult }> {
  const database = await openDatabase();
  const transaction = database.transaction(
    [METADATA_STORE, MANIFEST_STORE, FILE_STORE],
    'readonly',
  );
  const metadataStore = transaction.objectStore(METADATA_STORE);
  const manifestStore = transaction.objectStore(MANIFEST_STORE);
  const fileStore = transaction.objectStore(FILE_STORE);
  const [summary, storedManifest, storedFiles] = await Promise.all([
    request<SavedRecording | undefined>(metadataStore.get(id)),
    request<{ recordingId: string; manifest: RecordingManifest } | undefined>(
      manifestStore.get(id),
    ),
    request<StoredFile[]>(
      fileStore.index(RECORDING_INDEX).getAll(IDBKeyRange.only(id)),
    ),
  ]);
  await transactionComplete(transaction);

  if (!summary || !storedManifest) {
    throw new Error(`Recording ${id} was not found on this device.`);
  }

  storedFiles.sort((left, right) => left.position - right.position);
  return {
    summary,
    result: {
      manifest: storedManifest.manifest,
      files: storedFiles.map(({ name, blob }) => ({ name, blob })),
    },
  };
}

export async function deleteRecording(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(
    [METADATA_STORE, MANIFEST_STORE, FILE_STORE],
    'readwrite',
  );
  const completed = transactionComplete(transaction);

  try {
    const fileStore = transaction.objectStore(FILE_STORE);
    const fileKeys = await request(
      fileStore.index(RECORDING_INDEX).getAllKeys(IDBKeyRange.only(id)),
    );
    for (const key of fileKeys) fileStore.delete(key);
    transaction.objectStore(METADATA_STORE).delete(id);
    transaction.objectStore(MANIFEST_STORE).delete(id);
    await completed;
  } catch (error) {
    safelyAbort(transaction);
    await completed.catch(() => undefined);
    throw storageError(error, 'delete this recording');
  }

  dispatchChanged();
}

export async function renameRecording(
  id: string,
  title: string,
): Promise<void> {
  title = title.trim().slice(0, 120);
  if (!title) throw new Error('Give the recording a title.');
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, 'readwrite');
  const completed = transactionComplete(transaction);

  try {
    const store = transaction.objectStore(METADATA_STORE);
    const summary = await request<SavedRecording | undefined>(store.get(id));
    if (!summary) {
      safelyAbort(transaction);
      throw new Error(`Recording ${id} was not found on this device.`);
    }
    store.put({ ...summary, title });
    await completed;
  } catch (error) {
    safelyAbort(transaction);
    await completed.catch(() => undefined);
    if (
      error instanceof Error &&
      error.message.endsWith('was not found on this device.')
    ) {
      throw error;
    }
    throw storageError(error, 'rename this recording');
  }

  dispatchChanged();
}

function summarize(
  result: RecordingResult,
  metadata: { title: string; labels: Record<string, string> },
): SavedRecording {
  const started = Date.parse(result.manifest.startedAt);
  const stopped = Date.parse(result.manifest.stoppedAt);
  return {
    id: result.manifest.recordingId,
    title: metadata.title,
    labels: { ...metadata.labels },
    startedAt: result.manifest.startedAt,
    durationMs:
      Number.isFinite(started) && Number.isFinite(stopped)
        ? Math.max(0, stopped - started)
        : Math.max(
            0,
            ...result.manifest.tracks.map(
              (track) => track.startedOffsetMs + track.durationMs,
            ),
          ),
    bytes: result.files.reduce((total, file) => total + file.blob.size, 0),
    trackCount: result.manifest.tracks.length,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('Local recording storage is unavailable in this environment.'),
    );
  }

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const openRequest = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    openRequest.onupgradeneeded = () => {
      const database = openRequest.result;
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(MANIFEST_STORE)) {
        database.createObjectStore(MANIFEST_STORE, { keyPath: 'recordingId' });
      }
      if (!database.objectStoreNames.contains(FILE_STORE)) {
        const files = database.createObjectStore(FILE_STORE, {
          keyPath: 'key',
        });
        files.createIndex(RECORDING_INDEX, RECORDING_INDEX, { unique: false });
      }
    };
    openRequest.onerror = () =>
      reject(
        openRequest.error ??
          new Error('Could not open local recording storage.'),
      );
    openRequest.onblocked = () =>
      reject(
        new Error(
          'Local recording storage is blocked by another open app window.',
        ),
      );
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
  }).catch((error: unknown) => {
    databasePromise = undefined;
    throw error;
  });
  databasePromise = opening;
  return opening;
}

function request<T>(idbRequest: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () =>
      reject(
        idbRequest.error ??
          new Error('Local recording storage request failed.'),
      );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error('Local recording storage transaction was aborted.'),
      );
    transaction.onerror = () =>
      reject(
        transaction.error ??
          new Error('Local recording storage transaction failed.'),
      );
  });
}

function safelyAbort(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have been aborted or committed.
  }
}

function storageError(error: unknown, action: string): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  if (cause.name === 'QuotaExceededError') {
    return new Error(
      `There is not enough local storage to ${action}. Free device space or delete older recordings and try again.`,
      { cause },
    );
  }
  return new Error(`Could not ${action} on this device: ${cause.message}`, {
    cause,
  });
}

async function requestPersistentStorage(): Promise<void> {
  if (typeof navigator === 'undefined') return;
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is a browser policy hint; IndexedDB still works when it is denied.
  }
}

function dispatchChanged(): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(CHANGED_EVENT));
}
