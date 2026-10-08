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

export type UploadStatus = {
  id: string;
  attachment: MessageAttachment;
  offset: number;
  chunk_bytes: number;
  state: 'creating' | 'uploading' | 'assembled' | 'complete';
  fingerprint: string;
  expires_at: string;
};
export type ResumableOptions = {
  signal: AbortSignal;
  onProgress: (progress: number) => void;
  resumeId?: string;
  onSession?: (id: string) => void;
};
const uploads = new WeakMap<File, Map<string, string>>();
const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

/** A bounded identity hint prevents accidentally resuming a different local file.
 * Every uploaded chunk is separately checked by both the API and S3. */
export async function fileFingerprint(file: File): Promise<string> {
  const [head, tail] = await Promise.all([
    file.slice(0, 64 * 1024).arrayBuffer(),
    file.slice(Math.max(0, file.size - 64 * 1024)).arrayBuffer(),
  ]);
  const metadata = new TextEncoder().encode(
    `${file.name}\n${file.size}\n${file.lastModified}\n`,
  );
  const bytes = new Uint8Array(
    metadata.length + head.byteLength + tail.byteLength,
  );
  bytes.set(metadata);
  bytes.set(new Uint8Array(head), metadata.length);
  bytes.set(new Uint8Array(tail), metadata.length + head.byteLength);
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

export function cancelResumableUpload(
  room: string,
  id: string,
  signal?: AbortSignal,
) {
  return api<void>(`/rooms/${room}/uploads/${id}`, undefined, 'DELETE', signal);
}

function putChunk(
  room: string,
  upload: UploadStatus,
  bytes: ArrayBuffer,
  checksum: string,
  options: ResumableOptions,
): Promise<UploadStatus> {
  return new Promise((resolve, reject) => {
    const generation = sessionGeneration();
    const request = new XMLHttpRequest();
    let settled = false;
    const abort = () => request.abort();
    const finish = (error?: Error, value?: UploadStatus) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', abort);
      request.upload.onprogress = null;
      request.onload =
        request.onerror =
        request.onabort =
        request.ontimeout =
          null;
      if (error) reject(error);
      else resolve(value!);
    };
    if (options.signal.aborted) {
      finish(new DOMException('Upload paused', 'AbortError'));
      return;
    }
    request.open(
      'POST',
      apiHttpUrl(`/api/v1/rooms/${room}/uploads/${upload.id}/chunks`),
    );
    request.withCredentials = apiCredentials() === 'include';
    request.responseType = 'json';
    request.timeout = 120_000;
    for (const [name, value] of Object.entries(apiAuthHeaders()))
      request.setRequestHeader(name, value);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('Upload-Offset', String(upload.offset));
    request.setRequestHeader('X-Chunk-SHA256', checksum);
    request.upload.onprogress = (event) => {
      if (!options.signal.aborted && generation === sessionGeneration())
        options.onProgress(
          Math.min(
            99,
            Math.round(
              ((upload.offset + Math.min(event.loaded, bytes.byteLength)) /
                upload.attachment.size_bytes) *
                100,
            ),
          ),
        );
    };
    request.onload = () => {
      if (options.signal.aborted || generation !== sessionGeneration()) {
        finish(new DOMException('Upload paused', 'AbortError'));
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
          ),
        );
        return;
      }
      const value = request.response?.upload as UploadStatus | undefined;
      if (
        !value ||
        value.id !== upload.id ||
        value.offset < upload.offset + bytes.byteLength
      ) {
        finish(
          new Error('Upload progress could not be confirmed. Retry to resume.'),
        );
        return;
      }
      finish(undefined, value);
    };
    request.onerror = () =>
      finish(
        new Error(
          'Upload interrupted. Retry to resume from the last completed chunk.',
        ),
      );
    request.onabort = () =>
      finish(new DOMException('Upload paused', 'AbortError'));
    request.ontimeout = () =>
      finish(new Error('Upload timed out. Retry to resume.'));
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      request.send(bytes);
    } catch (error) {
      finish(
        error instanceof Error ? error : new Error('Could not start upload'),
      );
    }
  });
}

export async function uploadResumableAttachment(
  room: string,
  file: File,
  options: ResumableOptions,
): Promise<MessageAttachment> {
  const generation = sessionGeneration();
  const current = () => {
    if (options.signal.aborted || generation !== sessionGeneration())
      throw new DOMException('Upload paused', 'AbortError');
  };
  current();
  const fingerprint = await fileFingerprint(file);
  current();
  let cached = uploads.get(file);
  if (!cached) {
    cached = new Map();
    uploads.set(file, cached);
  }
  const existing = options.resumeId ?? cached.get(room);
  let upload: UploadStatus | undefined;
  if (existing) {
    try {
      upload = (
        await api<{ upload: UploadStatus }>(
          `/rooms/${room}/uploads/${existing}`,
          undefined,
          undefined,
          options.signal,
        )
      ).upload;
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 404))
        throw error;
      cached.delete(room);
    }
    current();
    if (upload && upload.fingerprint !== fingerprint)
      throw new Error(
        'This file differs from the saved upload. Remove it and choose the original file.',
      );
  }
  if (!upload)
    upload = (
      await api<{ upload: UploadStatus }>(
        `/rooms/${room}/uploads`,
        { filename: file.name, size_bytes: file.size, fingerprint },
        'POST',
        options.signal,
      )
    ).upload;
  current();
  cached.set(room, upload.id);
  options.onSession?.(upload.id);
  if (
    upload.attachment.size_bytes !== file.size ||
    upload.chunk_bytes < 1 ||
    upload.chunk_bytes > 8 * 1024 * 1024 ||
    upload.offset < 0 ||
    upload.offset > file.size
  )
    throw new Error('Invalid upload progress');
  options.onProgress(
    Math.min(99, Math.round((upload.offset / file.size) * 100)),
  );
  if (upload.state === 'complete') {
    cached.delete(room);
    options.onProgress(100);
    return upload.attachment;
  }
  try {
    while (upload.offset < file.size) {
      current();
      const bytes = await file
        .slice(
          upload.offset,
          Math.min(file.size, upload.offset + upload.chunk_bytes),
        )
        .arrayBuffer();
      const checksum = hex(await crypto.subtle.digest('SHA-256', bytes));
      current();
      upload = await putChunk(room, upload, bytes, checksum, options);
    }
    const result = await api<{ attachment: MessageAttachment }>(
      `/rooms/${room}/uploads/${upload.id}/complete`,
      {},
      'POST',
      options.signal,
    );
    current();
    cached.delete(room);
    options.onProgress(100);
    return result.attachment;
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      ['unsupported_file', 'infected_file', 'checksum_mismatch'].includes(
        error.code ?? '',
      )
    ) {
      void cancelResumableUpload(room, upload.id).catch(() => {});
      cached.delete(room);
    }
    throw error;
  }
}
