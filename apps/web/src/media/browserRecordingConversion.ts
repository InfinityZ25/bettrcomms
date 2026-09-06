import type { Conversion, DiscardedTrack, StreamTargetChunk } from 'mediabunny';

const MAX_BYTES = 512 * 1024 * 1024;

type RecordingFile = { name: string; blob: Blob };
type OutputFormat = 'mp4' | 'wav';
type Segment = { position: number; data: Uint8Array<ArrayBuffer> };

const abortError = () => new DOMException('Recording conversion was canceled.', 'AbortError');

/** Converts browser recordings locally. Media is never uploaded or written back to the source Blob. */
export async function convertBrowserRecording(
  file: RecordingFile,
  format: OutputFormat,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<RecordingFile> {
  if (signal?.aborted) throw abortError();
  if (!file.blob.size) throw new Error('The recording is empty and cannot be converted.');
  if (file.blob.size > MAX_BYTES)
    throw new Error('This recording exceeds the 512 MiB browser conversion limit. Download the original instead.');
  if (typeof VideoEncoder === 'undefined' && format === 'mp4')
    throw new Error('MP4 conversion requires WebCodecs video encoding in this browser.');
  if (typeof AudioDecoder === 'undefined')
    throw new Error(`${format.toUpperCase()} conversion requires WebCodecs audio decoding in this browser.`);

  const media = await import('mediabunny');
  const input = new media.Input({ source: new media.BlobSource(file.blob), formats: media.ALL_FORMATS });
  const segments: Segment[] = [];
  let maximumEnd = 0;
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      const start = chunk.position;
      const end = start + chunk.data.byteLength;
      if (!Number.isSafeInteger(start) || start < 0 || end > MAX_BYTES)
        throw new Error('Converted output exceeds the 512 MiB browser conversion limit.');
      // StreamTarget may rewrite container headers. Keep only the newest bytes
      // for overlapping ranges so retained output remains bounded by file size.
      const next: Segment[] = [];
      for (const segment of segments) {
        const segmentEnd = segment.position + segment.data.byteLength;
        if (segmentEnd <= start || segment.position >= end) next.push(segment);
        else {
          if (segment.position < start)
            next.push({ position: segment.position, data: segment.data.subarray(0, start - segment.position) as Uint8Array<ArrayBuffer> });
          if (segmentEnd > end)
            next.push({ position: end, data: segment.data.subarray(end - segment.position) as Uint8Array<ArrayBuffer> });
        }
      }
      next.push({ position: start, data: chunk.data });
      segments.splice(0, segments.length, ...next);
      maximumEnd = Math.max(maximumEnd, end);
    },
  });
  const target = new media.StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 });
  const output = new media.Output({
    format: format === 'mp4'
      ? new media.Mp4OutputFormat({ fastStart: false })
      : new media.WavOutputFormat(),
    target,
  });
  let conversion: Conversion | undefined;
  let completed = false;
  const cancel = () => { if (conversion) void conversion.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    conversion = await media.Conversion.init({
      input,
      output,
      showWarnings: false,
      video: format === 'mp4'
        ? { codec: 'avc', quality: new media.Quality('high'), forceTranscode: true, hardwareAcceleration: 'no-preference' }
        : { discard: true },
      audio: format === 'mp4'
        ? { codec: 'aac', quality: new media.Quality('high'), forceTranscode: true }
        : { codec: 'pcm-s16', sampleFormat: 's16', quality: new media.Quality('high'), forceTranscode: true },
    });
    if (signal?.aborted) { await conversion.cancel(); throw abortError(); }
    const requiredType = format === 'mp4' ? 'video' : 'audio';
    const unexpectedDiscard = conversion.discardedTracks.some(({ reason }) => reason !== 'discarded_by_user');
    if (!conversion.isValid || unexpectedDiscard || !conversion.utilizedTracks.some((track) => track.type === requiredType)) {
      const reasons = [...new Set(conversion.discardedTracks
        .filter(({ reason }: DiscardedTrack) => reason !== 'discarded_by_user')
        .map(({ reason }: DiscardedTrack) => reason.replaceAll('_', ' ')))];
      throw new Error(
        `This browser cannot convert the recording to ${format.toUpperCase()}${reasons.length ? `: ${reasons.join(', ')}` : '.'}`,
      );
    }
    let reportedProgress = 0;
    onProgress?.(reportedProgress);
    conversion.onProgress = (progress: number) => {
      reportedProgress = Math.max(reportedProgress, Math.min(1, Math.max(0, progress)));
      onProgress?.(reportedProgress);
    };
    await conversion.execute();
    completed = true;
    if (signal?.aborted) throw abortError();
    onProgress?.(1);
  } catch (error) {
    if (signal?.aborted || error instanceof media.ConversionCanceledError) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (conversion && !completed) await conversion.cancel().catch(() => undefined);
    input.dispose();
  }

  segments.sort((a, b) => a.position - b.position);
  let position = 0;
  const parts: BlobPart[] = [];
  for (const segment of segments) {
    if (segment.position !== position)
      throw new Error('Converted output was incomplete. Keep the original recording and try again.');
    parts.push(segment.data);
    position += segment.data.byteLength;
  }
  if (!position || position !== maximumEnd)
    throw new Error('Conversion did not produce a complete output file.');
  const mimeType = format === 'mp4' ? 'video/mp4' : 'audio/wav';
  return {
    name: file.name.replace(/\.[^.]+$/, '') + `.${format}`,
    blob: new Blob(parts, { type: mimeType }),
  };
}
