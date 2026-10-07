import { api, ApiRequestError, type MessageAttachment } from '@/api';
import {
  apiAuthHeaders,
  apiCredentials,
  apiHttpUrl,
} from '@/desktop/apiTransport';
import {
  sessionExpired,
  sessionGeneration,
} from '@/features/auth/sessionEvents';

export type AttachmentLimits = {
  available: boolean;
  max_file_bytes: number;
  max_voice_note_bytes: number;
  max_per_message: number;
};

export const defaultAttachmentLimits: AttachmentLimits = {
  available: true,
  max_file_bytes: 500 * 1024 * 1024,
  max_voice_note_bytes: 10 * 1024 * 1024,
  max_per_message: 4,
};

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

/** Only passive formats can appear inline. SVG, HTML and documents stay downloads. */
export function attachmentKind(
  contentType: string,
  filename = '',
): AttachmentKind {
  const mime = contentType.toLowerCase().split(';', 1)[0].trim();
  if (
    [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/avif',
      'image/bmp',
      'image/x-icon',
      'image/vnd.microsoft.icon',
    ].includes(mime)
  )
    return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  // Some OS file pickers leave the MIME empty. This is only a local preview hint;
  // the server determines the trusted MIME before making a signed inline link.
  if (!mime) {
    const extension = filename.toLowerCase().split('.').pop();
    if (
      ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'].includes(
        extension ?? '',
      )
    )
      return 'image';
    if (['mp4', 'm4v', 'webm', 'mov'].includes(extension ?? '')) return 'video';
    if (['mp3', 'm4a', 'ogg', 'wav', 'flac', 'aac'].includes(extension ?? ''))
      return 'audio';
  }
  return 'file';
}

export function attachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${Number(value.toFixed(value < 10 ? 1 : 0))} ${units[index]}`;
}

export async function loadAttachmentLimits(
  signal: AbortSignal,
): Promise<AttachmentLimits> {
  const { attachments } = await api<{ attachments?: AttachmentLimits }>(
    '/config',
    undefined,
    undefined,
    signal,
  );
  if (!attachments) return defaultAttachmentLimits;
  return {
    available: attachments.available,
    max_file_bytes: Math.max(1, attachments.max_file_bytes),
    max_voice_note_bytes: Math.max(1, attachments.max_voice_note_bytes),
    max_per_message: Math.max(1, Math.min(4, attachments.max_per_message)),
  };
}

/** FormData streams the original File; no full-size arrayBuffer/base64 copy. */
export function uploadAttachmentWithProgress(
  roomId: string,
  file: File,
  options: {
    signal: AbortSignal;
    onProgress: (progress: number) => void;
    voiceNote?: boolean;
    durationMs?: number;
  },
): Promise<MessageAttachment> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'));
      return;
    }
    const generation = sessionGeneration();
    const request = new XMLHttpRequest();
    const body = new FormData();
    body.append('file', file);
    if (options.voiceNote) {
      body.append('voice_note', 'true');
      body.append('duration_ms', String(options.durationMs ?? 0));
    }
    let settled = false;
    const abort = () => request.abort();
    const finish = (error?: Error, attachment?: MessageAttachment) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      request.upload.onprogress = null;
      request.onload = null;
      request.onerror = null;
      request.onabort = null;
      request.ontimeout = null;
      if (error) reject(error);
      else resolve(attachment!);
    };
    request.open('POST', apiHttpUrl(`/api/v1/rooms/${roomId}/attachments`));
    request.withCredentials = apiCredentials() === 'include';
    request.responseType = 'json';
    for (const [name, value] of Object.entries(apiAuthHeaders()))
      request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && !signal.aborted)
        options.onProgress(
          Math.min(100, Math.round((event.loaded / event.total) * 100)),
        );
    };
    request.onload = () => {
      if (signal.aborted || generation !== sessionGeneration()) {
        finish(new DOMException('Upload cancelled', 'AbortError'));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        if (request.status === 401) sessionExpired(generation);
        finish(
          new ApiRequestError(
            request.response?.error?.message ??
              `Upload failed (${request.status})`,
            request.status,
            request.response?.error?.code,
            Number(request.getResponseHeader('Retry-After')) || undefined,
          ),
        );
        return;
      }
      const attachment = request.response?.attachment as
        MessageAttachment | undefined;
      if (!attachment?.id) {
        finish(
          new Error('The upload could not be confirmed. Retry this file.'),
        );
        return;
      }
      finish(undefined, attachment);
    };
    request.onerror = () =>
      finish(
        new Error(
          'Upload interrupted. Check your connection and retry this file.',
        ),
      );
    request.onabort = () =>
      finish(new DOMException('Upload cancelled', 'AbortError'));
    request.ontimeout = () =>
      finish(new Error('Upload timed out. Retry this file.'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      request.send(body);
    } catch (error) {
      finish(
        error instanceof Error
          ? error
          : new Error('Could not start the upload.'),
      );
    }
  });
}

export function discardPendingAttachment(
  roomId: string,
  id: string,
  signal?: AbortSignal,
) {
  return api<void>(
    `/rooms/${roomId}/attachments/${id}`,
    undefined,
    'DELETE',
    signal,
  );
}

export async function signedAttachmentURL(
  roomId: string,
  id: string,
  signal: AbortSignal,
) {
  const result = await api<{ url: string }>(
    `/rooms/${roomId}/attachments/${id}?link=1&inline=1`,
    undefined,
    undefined,
    signal,
  );
  const parsed = new URL(result.url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('Invalid attachment URL');
  return result.url;
}

/** Keep the popup in the user's click gesture, but never navigate it with a
 * response belonging to a closed conversation or a previous account. */
export async function downloadMessageAttachment(
  roomId: string,
  id: string,
  filename: string,
  options: { signal: AbortSignal; onError: (message: string) => void },
): Promise<boolean> {
  const { signal, onError } = options;
  const generation = sessionGeneration();
  const current = () => !signal.aborted && generation === sessionGeneration();
  if (!current()) return false;
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  let closed = false;
  const closeTab = () => {
    if (tab && !closed) {
      closed = true;
      tab.close();
    }
  };
  signal.addEventListener('abort', closeTab, { once: true });
  try {
    const result = await api<{ url: string }>(
      `/rooms/${roomId}/attachments/${id}?link=1`,
      undefined,
      undefined,
      signal,
    );
    if (!current()) {
      closeTab();
      return false;
    }
    const url = new URL(result.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('Invalid attachment URL');
    if (tab) tab.location.href = url.href;
    else {
      const link = document.createElement('a');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
      link.download = filename;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
      }
    }
    return true;
  } catch (error) {
    closeTab();
    if (current())
      onError(
        error instanceof Error ? error.message : 'Could not open attachment',
      );
    return false;
  } finally {
    signal.removeEventListener('abort', closeTab);
  }
}
