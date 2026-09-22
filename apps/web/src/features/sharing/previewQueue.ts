/**
 * Native thumbnails are expensive to grab, so at most two are in flight at a
 * time and the rest wait in this shared queue. It is module state on purpose:
 * the limit is a property of the machine, not of any one preview tile.
 */
const queue: Array<() => Promise<void>> = [];
let active = 0;
const CONCURRENCY = 2;

export function enqueuePreview(request: () => Promise<void>) {
  queue.push(request);
  pump();
}

export function cancelPreview(request: () => Promise<void>) {
  const index = queue.indexOf(request);
  if (index >= 0) queue.splice(index, 1);
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const next = queue.shift()!;
    active++;
    void next().finally(() => {
      active--;
      pump();
    });
  }
}

/** Tauri may hand back an ArrayBuffer, a view, a number array, or a wrapper. */
export function thumbnailBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(data);
  if (data && typeof data === 'object') {
    const wrapped = (data as { data?: unknown }).data;
    if (Array.isArray(wrapped)) return new Uint8Array(wrapped);
  }
  throw new Error('Native preview returned an unsupported image format');
}

/** A truncated capture decodes as a torn image; require the JPEG end marker. */
export function isCompleteJpeg(bytes: Uint8Array) {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  );
}

export type PreviewCache = Map<string, { blob: Blob; at: number }>;

export const PREVIEW_MAX_AGE_MS = 30_000;
const MAX_ENTRIES = 32;
const MAX_BYTES = 8 * 1024 * 1024;

/** Most-recently-stored wins; the cache is trimmed by both count and total size. */
export function cachePreview(cache: PreviewCache, id: string, blob: Blob) {
  cache.delete(id);
  cache.set(id, { blob, at: Date.now() });
  while (
    cache.size > MAX_ENTRIES ||
    [...cache.values()].reduce((sum, entry) => sum + entry.blob.size, 0) > MAX_BYTES
  )
    cache.delete(cache.keys().next().value!);
}
