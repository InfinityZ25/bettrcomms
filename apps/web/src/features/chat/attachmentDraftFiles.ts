import type { PendingAttachment } from './drafts';

type StoredFile = {
  key: string;
  file: File;
  savedAt: number;
  lastModified: number;
};
const lifetime = 24 * 60 * 60 * 1000;
const written = new WeakSet<File>();
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('bettercomms-attachment-drafts', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('files', { keyPath: 'key' });
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    });
  return database;
}
const prefix = (user: string, room: string, root?: string) =>
  `${user}:${room}:${root ?? ''}:`;
const key = (
  user: string,
  room: string,
  root: string | undefined,
  id: string,
) => prefix(user, room, root) + id;
function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () =>
      reject(transaction.error ?? new Error('Draft file storage failed'));
  });
}

/** Blob bytes are written once per selected File, never on every progress tick
 * or keystroke. Metadata and the durable upload ID live in the text draft. */
export async function persistDraftFiles(
  user: string,
  room: string,
  attachments: PendingAttachment[],
  root?: string,
): Promise<void> {
  const db = await open();
  const transaction = db.transaction('files', 'readwrite');
  const complete = finished(transaction);
  const store = transaction.objectStore('files');
  const selected = new Set(
    attachments
      .filter((item) => item.localId)
      .map((item) => key(user, room, root, item.localId!)),
  );
  const newlyWritten: File[] = [];
  for (const item of attachments)
    if (item.file && item.localId && !written.has(item.file)) {
      store.put({
        key: key(user, room, root, item.localId),
        file: item.file,
        savedAt: Date.now(),
        lastModified: item.file.lastModified,
      } satisfies StoredFile);
      newlyWritten.push(item.file);
    }
  const cursor = store.openCursor();
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) return;
    const value = current.value as StoredFile;
    if (
      Date.now() - value.savedAt > lifetime ||
      (value.key.startsWith(prefix(user, room, root)) &&
        !selected.has(value.key))
    )
      current.delete();
    current.continue();
  };
  await complete;
  newlyWritten.forEach((file) => written.add(file));
}

export async function restoreDraftFiles(
  user: string,
  room: string,
  attachments: PendingAttachment[],
  root?: string,
): Promise<PendingAttachment[]> {
  const db = await open();
  const transaction = db.transaction('files', 'readonly');
  const complete = finished(transaction);
  const store = transaction.objectStore('files');
  const restored = await Promise.all(
    attachments.map(
      (item) =>
        new Promise<PendingAttachment>((resolve, reject) => {
          if (!item.localId) {
            resolve(item);
            return;
          }
          const request = store.get(key(user, room, root, item.localId));
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const value = request.result as StoredFile | undefined;
            const blob: unknown =
              value && Date.now() - value.savedAt < lifetime
                ? value.file
                : undefined;
            const file =
              blob instanceof File
                ? blob
                : blob instanceof Blob
                  ? new File([blob], item.filename, {
                      type: item.content_type,
                      lastModified: value?.lastModified,
                    })
                  : undefined;
            if (file) written.add(file);
            resolve({
              ...item,
              file,
              uploadState: item.id ? 'ready' : 'queued',
              uploadError:
                !item.id && !file
                  ? 'Choose the file again. Your browser could not retain its bytes.'
                  : undefined,
            });
          };
        }),
    ),
  );
  await complete;
  return restored;
}
export function clearDraftFiles(user: string, room: string, root?: string) {
  void persistDraftFiles(user, room, [], root).catch(() => {});
}
