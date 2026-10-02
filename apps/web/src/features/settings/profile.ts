import { ApiRequestError, type User } from '@/api';
import { apiAuthHeaders, apiCredentials, apiHttpUrl } from '@/desktop/apiTransport';
import { sessionExpired, sessionGeneration } from '@/features/auth/sessionEvents';

export type ProfileDraft = { name: string; username: string; bio: string };
export function normalizeProfile(draft: ProfileDraft): ProfileDraft {
  return { name: draft.name.trim(), username: draft.username.trim().toLowerCase(), bio: draft.bio.trim() };
}
export function profileValidation(draft: ProfileDraft): string {
  if (!draft.name || [...draft.name].length > 80) return 'Use a display name between 1 and 80 characters.';
  if (!/^[a-z0-9_]{3,32}$/.test(draft.username)) return 'Use 3–32 lowercase letters, numbers or underscores for your username.';
  if ([...draft.bio].length > 160) return 'Keep your description within 160 characters.';
  return '';
}

/** Decode one bounded image, resize locally and release every browser image resource. */
export async function prepareProfileAvatar(file: File, signal?: AbortSignal): Promise<File> {
  signal?.throwIfAborted();
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choose a PNG or JPEG image.');
  if (!file.size || file.size > 2 * 1024 * 1024) throw new Error('Choose an image smaller than 2 MB.');
  const url = URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement('canvas');
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('This image could not be opened.'));
      abort = () => reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      image.src = url;
    });
    signal?.throwIfAborted();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 4_000_000) throw new Error('Choose an image with at most 4 million pixels.');
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    canvas.width = canvas.height = Math.min(256, side);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image resizing is unavailable.');
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, file.type, 0.86));
    if (!encoded || !encoded.size || encoded.size > 256 * 1024) throw new Error('The resized image is too large. Choose a simpler image.');
    return new File([encoded], file.type === 'image/png' ? 'avatar.png' : 'avatar.jpg', { type: file.type });
  } finally {
    image.onload = null;
    image.onerror = null;
    if (abort) signal?.removeEventListener('abort', abort);
    image.src = '';
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
  }
}
export async function uploadProfileAvatar(file: File, signal?: AbortSignal): Promise<User> {
  const generation = sessionGeneration();
  const body = new FormData();
  body.append('file', file);
  const response = await fetch(apiHttpUrl('/api/v1/me/avatar'), {
    method: 'POST', credentials: apiCredentials(), headers: apiAuthHeaders(), body, signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    if (response.status === 401 && !signal?.aborted) sessionExpired(generation);
    throw new ApiRequestError(error?.error?.message ?? `Upload failed (${response.status})`, response.status);
  }
  return (await response.json()).user as User;
}
