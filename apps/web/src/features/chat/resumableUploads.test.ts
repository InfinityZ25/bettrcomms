import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type MessageAttachment } from '@/api';
import { setSessionIdentity } from '@/features/auth/sessionEvents';
import {
  uploadResumableAttachment,
  type UploadStatus,
} from './resumableUploads';

vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  api: vi.fn(),
}));
const chunkRequests: { offset: number; bytes: number; checksum: string }[] = [];
let status: UploadStatus;
class ChunkRequest {
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  responseType = '';
  withCredentials = false;
  status = 200;
  response: unknown;
  headers: Record<string, string> = {};
  open() {}
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  abort() {
    this.onabort?.();
  }
  send(body: ArrayBuffer) {
    chunkRequests.push({
      offset: Number(this.headers['Upload-Offset']),
      bytes: body.byteLength,
      checksum: this.headers['X-Chunk-SHA256'],
    });
    status = {
      ...status,
      offset: Number(this.headers['Upload-Offset']) + body.byteLength,
    };
    this.response = { upload: status };
    queueMicrotask(() => this.onload?.());
  }
}
beforeEach(() => {
  chunkRequests.length = 0;
  setSessionIdentity('uploader');
  vi.stubGlobal('XMLHttpRequest', ChunkRequest);
});
afterEach(() => {
  vi.mocked(api).mockReset();
  vi.unstubAllGlobals();
  setSessionIdentity(null);
});
function attachment(id: string, size: number): MessageAttachment {
  return {
    id,
    filename: 'notes.txt',
    content_type: 'text/plain',
    size_bytes: size,
  };
}
function upload(
  id: string,
  file: File,
  fingerprint: string,
  offset: number,
): UploadStatus {
  return {
    id,
    attachment: attachment(id, file.size),
    offset,
    chunk_bytes: 8 * 1024 * 1024,
    fingerprint,
    state: 'uploading',
    expires_at: new Date(Date.now() + 10000).toISOString(),
  };
}

describe('durable upload client', () => {
  it('resumes at the server offset and hashes bounded chunks instead of rereading the full file', async () => {
    const file = new File([new Uint8Array(9 * 1024 * 1024)], 'notes.txt', {
      lastModified: 123,
    });
    const wholeFile = vi.spyOn(file, 'arrayBuffer');
    const { fileFingerprint } = await import('./resumableUploads');
    const fingerprint = await fileFingerprint(file);
    status = upload('persisted', file, fingerprint, 8 * 1024 * 1024);
    vi.mocked(api)
      .mockResolvedValueOnce({ upload: status })
      .mockResolvedValueOnce({ attachment: status.attachment });
    const progress = vi.fn();
    await expect(
      uploadResumableAttachment('room', file, {
        resumeId: 'persisted',
        signal: new AbortController().signal,
        onProgress: progress,
      }),
    ).resolves.toEqual(status.attachment);
    expect(chunkRequests).toEqual([
      {
        offset: 8 * 1024 * 1024,
        bytes: 1024 * 1024,
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(wholeFile).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(100);
  });
  it('clears successful upload cache so the same File can be shared in another message', async () => {
    const file = new File(['original bytes'], 'notes.txt');
    const { fileFingerprint } = await import('./resumableUploads');
    const fingerprint = await fileFingerprint(file);
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.endsWith('/uploads')) {
        status = upload(
          chunkRequests.length ? 'second' : 'first',
          file,
          fingerprint,
          0,
        );
        return { upload: status };
      }
      if (path.endsWith('/complete')) return { attachment: status.attachment };
      throw new Error('Successful upload was reused from cache');
    });
    const options = {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    };
    expect((await uploadResumableAttachment('room', file, options)).id).toBe(
      'first',
    );
    expect((await uploadResumableAttachment('room', file, options)).id).toBe(
      'second',
    );
    expect(chunkRequests.map((request) => request.offset)).toEqual([0, 0]);
  });
  it('does not resume another file with the same display name and size', async () => {
    const file = new File(['changed bytes'], 'notes.txt');
    status = upload('persisted', file, 'a-different-fingerprint', 0);
    vi.mocked(api).mockResolvedValueOnce({ upload: status });
    await expect(
      uploadResumableAttachment('room', file, {
        resumeId: 'persisted',
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow('differs from the saved upload');
    expect(chunkRequests).toHaveLength(0);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
