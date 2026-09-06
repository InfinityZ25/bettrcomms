import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ExportResult } from './recordingExport';

export type RecordingConversionFormat = 'mp4' | 'wav' | 'mp3';
export type ConversionCapabilities = {
  available: boolean;
  detail: string;
  formats: { id: RecordingConversionFormat; extension: string; label: string; available: boolean }[];
};
let capabilityRequest: Promise<ConversionCapabilities | null> | undefined;
export function nativeConversionCapabilities(): Promise<ConversionCapabilities | null> {
  if (!isTauri()) return Promise.resolve(null);
  return capabilityRequest ??= invoke<ConversionCapabilities>('recording_conversion_capabilities').catch(() => null);
}

/** The host owns the chosen path and a temporary file; the webview only gets an opaque grant. */
export async function saveConvertedRecordingAsset(
  file: { name: string; blob: Blob }, format: RecordingConversionFormat,
  signal: AbortSignal, onProgress: (fraction: number | null) => void,
): Promise<ExportResult> {
  if (!isTauri()) throw new Error('Native conversion requires the desktop app.');
  signal.throwIfAborted();
  const grant = await invoke<{ exportId: string } | null>('recording_conversion_begin', {
    fileName: file.name, sizeBytes: file.blob.size, format,
  });
  if (!grant) return null;
  let committed = false;
  const abort = () => { void invoke('recording_export_abort', { exportId: grant.exportId }).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < file.blob.size; offset += chunkSize) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await file.blob.slice(offset, offset + chunkSize).arrayBuffer());
      signal.throwIfAborted();
      await invoke('recording_export_append', { exportId: grant.exportId, offset, bytes: Array.from(bytes) });
      onProgress(Math.min(1, (offset + bytes.length) / file.blob.size));
    }
    signal.throwIfAborted();
    onProgress(null);
    const result = await invoke<Exclude<ExportResult, null>>('recording_conversion_finish', { exportId: grant.exportId });
    committed = true;
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!committed) await invoke('recording_export_abort', { exportId: grant.exportId }).catch(() => {});
  }
}
