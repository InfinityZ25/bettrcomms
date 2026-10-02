import { apiAuthHeaders, apiCredentials, apiHttpUrl } from '@/desktop/apiTransport';

const MAX_CACHED_AVATARS = 64;
const MAX_IMAGE_BYTES = 256 * 1024;
type Entry = { url?: string; controller?: AbortController; failed: boolean; listeners: Set<() => void> };
const entries = new Map<string, Entry>();

/** Only an exact API image resource may receive the desktop proxy's credentials. */
export function avatarApiPath(value: string | null | undefined): string | undefined {
  if (!value || !/^\/(?:api\/v1\/)?users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/avatar\?version=[0-9]{1,16}$/i.test(value)) return;
  return value.startsWith('/api/v1/') ? value : `/api/v1${value}`;
}
function discard(path: string, entry: Entry) {
  entry.controller?.abort();
  if (entry.url) URL.revokeObjectURL(entry.url);
  entries.delete(path);
}
function trim() {
  for (const [path, entry] of entries) {
    if (entries.size <= MAX_CACHED_AVATARS) break;
    if (!entry.listeners.size) discard(path, entry);
  }
}
async function boundedImage(response: Response, type: string) {
  const declaredSize = Number(response.headers.get('Content-Length'));
  if (declaredSize > MAX_IMAGE_BYTES) throw new Error('Invalid avatar size');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Avatar body unavailable');
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error('Invalid avatar size');
      }
      chunks.push(new Uint8Array(value).buffer);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error('Empty avatar');
  return new Blob(chunks, { type });
}
async function load(path: string, entry: Entry) {
  const controller = new AbortController();
  entry.controller = controller;
  try {
    const response = await fetch(apiHttpUrl(path), {
      credentials: apiCredentials(), headers: apiAuthHeaders(), signal: controller.signal,
    });
    if (!response.ok) throw new Error('Avatar unavailable');
    const contentType = response.headers.get('Content-Type')?.split(';')[0];
    if (contentType !== 'image/png' && contentType !== 'image/jpeg') throw new Error('Invalid avatar');
    const body = await boundedImage(response, contentType);
    if (controller.signal.aborted || entries.get(path) !== entry || !entry.listeners.size) return;
    entry.url = URL.createObjectURL(body);
  } catch {
    if (!controller.signal.aborted) entry.failed = true;
  } finally {
    entry.controller = undefined;
    if (entries.get(path) === entry) for (const listener of entry.listeners) listener();
  }
}
export const avatarSnapshot = (path: string) => entries.get(path)?.url;
export function subscribeAvatar(path: string, listener: () => void) {
  if (avatarApiPath(path) !== path) return () => {};
  let entry = entries.get(path);
  if (!entry) {
    entry = { failed: false, listeners: new Set() };
    entries.set(path, entry);
  }
  entry.listeners.add(listener);
  if (!entry.url && !entry.failed && !entry.controller) void load(path, entry);
  trim();
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size && (entry.controller || entry.failed)) discard(path, entry);
    trim();
  };
}
export function clearAvatarCache() {
  const listeners = new Set<() => void>();
  for (const [path, entry] of entries) {
    for (const listener of entry.listeners) listeners.add(listener);
    discard(path, entry);
  }
  for (const listener of listeners) listener();
}
