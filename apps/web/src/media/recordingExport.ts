import { invoke, isTauri } from '@tauri-apps/api/core';

export type ExportResult = { fileName: string; path: string } | null;

/** Save originals without decoding, remuxing, or applying playback volume. */
export async function saveRecordingAsset(
  file: { name: string; blob: Blob },
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<ExportResult> {
  if (!isTauri())
    throw new Error('Native export is available only in the desktop app.');
  signal.throwIfAborted();
  let grant: { exportId: string } | null;
  try {
    grant = await invoke<{ exportId: string } | null>(
      'recording_export_begin',
      {
        fileName: file.name,
        sizeBytes: file.blob.size,
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/command\s+recording_export_begin\s+not found/i.test(detail)) {
      throw new Error(
        'This desktop window is using an outdated native host. Close Bettercomms and start it again before exporting original recordings.',
      );
    }
    throw error;
  }
  if (!grant) return null;
  let committed = false;
  try {
    signal.throwIfAborted();
    // Sequential bounded chunks avoid duplicating a whole recording in IPC.
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < file.blob.size; offset += chunkSize) {
      signal.throwIfAborted();
      const data = await file.blob
        .slice(offset, offset + chunkSize)
        .arrayBuffer();
      signal.throwIfAborted();
      await invoke('recording_export_append', {
        exportId: grant.exportId,
        offset,
        bytes: Array.from(new Uint8Array(data)),
      });
      onProgress(Math.min(1, (offset + data.byteLength) / file.blob.size));
    }
    signal.throwIfAborted();
    const saved = await invoke<Exclude<ExportResult, null>>(
      'recording_export_finish',
      {
        exportId: grant.exportId,
      },
    );
    committed = true;
    return saved;
  } finally {
    if (!committed)
      await invoke('recording_export_abort', {
        exportId: grant.exportId,
      }).catch(() => {});
  }
}
