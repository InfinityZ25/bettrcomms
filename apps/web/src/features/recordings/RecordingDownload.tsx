import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Download, FileDown, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { saveRecordingAsset } from '@/media/recordingExport';
import {
  nativeConversionCapabilities,
  saveConvertedRecordingAsset,
  type ConversionCapabilities,
  type RecordingConversionFormat,
} from '@/media/nativeRecordingConversion';
import './RecordingDownload.css';

export function RecordingDownload({
  file,
  label,
  mediaKind,
}: {
  file: { name: string; blob: Blob };
  label?: string;
  mediaKind?: 'audio' | 'video';
}) {
  const desktop = isTauri();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);
  const kind =
    mediaKind ??
    (file.blob.type.startsWith('audio/')
      ? 'audio'
      : file.blob.type.startsWith('video/')
        ? 'video'
        : undefined);
  const convertible =
    kind === 'audio' || (kind === 'video' && !/\.mp4$/i.test(file.name));
  const [format, setFormat] = useState<RecordingConversionFormat>(
    kind === 'audio' ? 'wav' : 'mp4',
  );
  const [capabilities, setCapabilities] =
    useState<ConversionCapabilities | null>(null);
  const [converted, setConverted] = useState<{
    name: string;
    url: string;
  } | null>(null);
  const convertedUrl = useRef('');
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    let active = true;
    if (desktop && convertible)
      void nativeConversionCapabilities().then((value) => {
        if (active) setCapabilities(value);
      });
    return () => {
      active = false;
    };
  }, [desktop, convertible]);
  useEffect(() => {
    alive.current = true;
    const value = desktop ? '' : URL.createObjectURL(file.blob);
    setUrl(value);
    setConverted(null);
    setBusy(false);
    setProgress(null);
    setStatus('');
    return () => {
      alive.current = false;
      controller.current?.abort();
      controller.current = null;
      if (convertedUrl.current) URL.revokeObjectURL(convertedUrl.current);
      if (value) URL.revokeObjectURL(value);
    };
  }, [file.blob, desktop]);

  async function convert() {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    const current = () => alive.current && controller.current === request;
    if (convertedUrl.current) URL.revokeObjectURL(convertedUrl.current);
    convertedUrl.current = '';
    setConverted(null);
    setBusy(true);
    setError(false);
    setProgress(null);
    setStatus('Preparing conversion…');
    try {
      if (
        desktop &&
        capabilities?.formats.some(
          (item) => item.id === format && item.available,
        )
      ) {
        const saved = await saveConvertedRecordingAsset(
          file,
          format,
          request.signal,
          (value) => {
            if (current()) {
              setProgress(value);
              setStatus(
                value === null
                  ? 'Converting locally…'
                  : 'Preparing source file…',
              );
            }
          },
        );
        if (current())
          setStatus(saved ? `Saved to ${saved.path}` : 'Save cancelled.');
      } else {
        if (format === 'mp3')
          throw new Error(
            'MP3 conversion requires the updated desktop app and its FFmpeg runtime.',
          );
        const { convertBrowserRecording } =
          await import('@/media/browserRecordingConversion');
        const output = await convertBrowserRecording(
          file,
          format,
          request.signal,
          (value) => {
            if (current()) {
              setProgress(value);
              setStatus('Converting locally…');
            }
          },
        );
        request.signal.throwIfAborted();
        if (desktop) {
          const saved = await saveRecordingAsset(
            output,
            request.signal,
            (value) => {
              if (current()) {
                setProgress(value);
                setStatus('Saving converted file…');
              }
            },
          );
          if (current())
            setStatus(saved ? `Saved to ${saved.path}` : 'Save cancelled.');
        } else if (current()) {
          convertedUrl.current = URL.createObjectURL(output.blob);
          setConverted({ name: output.name, url: convertedUrl.current });
          setStatus('Conversion complete. Your download is ready.');
        }
      }
    } catch (reason) {
      if (current()) {
        setError(!request.signal.aborted);
        setStatus(
          request.signal.aborted
            ? 'Conversion cancelled.'
            : `Could not convert: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    } finally {
      if (current()) {
        setBusy(false);
        setProgress(null);
      }
      if (controller.current === request) controller.current = null;
    }
  }

  async function save() {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    const current = () => alive.current && controller.current === request;
    setBusy(true);
    setError(false);
    setProgress(null);
    setStatus('Choose where to save this original file…');
    try {
      const saved = await saveRecordingAsset(file, request.signal, (value) => {
        if (current()) {
          setProgress(value);
          setStatus('Saving original file…');
        }
      });
      if (current())
        setStatus(saved ? `Saved to ${saved.path}` : 'Save cancelled.');
    } catch (reason) {
      if (current()) {
        setError(!request.signal.aborted);
        setStatus(
          request.signal.aborted
            ? 'Save cancelled.'
            : `Could not save: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    } finally {
      if (current()) {
        setBusy(false);
        setProgress(null);
      }
      if (controller.current === request) controller.current = null;
    }
  }
  const size =
    file.blob.size >= 1048576
      ? `${(file.blob.size / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.ceil(file.blob.size / 1024))} KB`;
  const contents = (
    <>
      <FileDown size={19} aria-hidden="true" />
      <span className="recording-asset__name">
        <strong>{label ?? file.name}</strong>
        {label && <small>{file.name}</small>}
      </span>
      <span className="recording-asset__size">{size}</span>
      <span className="recording-asset__action">
        {busy ? (
          <LoaderCircle size={16} aria-hidden="true" />
        ) : (
          <Download size={16} aria-hidden="true" />
        )}
        {busy
          ? progress === null
            ? 'Save as…'
            : `${Math.round(progress * 100)}%`
          : desktop
            ? 'Save as…'
            : 'Download'}
      </span>
    </>
  );
  return (
    <div className="recording-asset">
      {desktop ? (
        <button
          type="button"
          className="recording-asset__download"
          onClick={() => void save()}
          disabled={busy}
          aria-label={`Save original ${label ?? file.name}`}
        >
          {contents}
        </button>
      ) : (
        <a
          className="recording-asset__download"
          href={url}
          download={file.name}
          aria-label={`Download original ${label ?? file.name}`}
        >
          {contents}
        </a>
      )}
      {convertible && (
        <div className="recording-asset__convert">
          <label>
            Export a copy
            <select
              aria-label={`Export format for ${label ?? file.name}`}
              value={format}
              disabled={busy}
              onChange={(event) =>
                setFormat(event.target.value as RecordingConversionFormat)
              }
            >
              {kind === 'video' ? (
                <option value="mp4">MP4 · H.264 video</option>
              ) : (
                <>
                  <option value="wav">WAV · uncompressed audio</option>
                  {desktop && (
                    <option
                      value="mp3"
                      disabled={
                        !capabilities?.formats.some(
                          (item) => item.id === 'mp3' && item.available,
                        )
                      }
                    >
                      MP3 · compact audio
                      {!capabilities?.formats.some(
                        (item) => item.id === 'mp3' && item.available,
                      )
                        ? ' (native converter required)'
                        : ''}
                    </option>
                  )}
                </>
              )}
            </select>
          </label>
          <Button
            variant="secondary"
            type="button"
            disabled={busy}
            onClick={() => void convert()}
          >
            {busy ? 'Working…' : desktop ? 'Convert & save…' : 'Convert'}
          </Button>
          {converted && (
            <a
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
              href={converted.url}
              download={converted.name}
            >
              Download {converted.name.split('.').pop()?.toUpperCase()}
            </a>
          )}
          <small>Processed on this device. The original stays unchanged.</small>
        </div>
      )}
      {busy && (
        <button
          className="my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
          type="button"
          onClick={() => controller.current?.abort()}
        >
          Cancel export
        </button>
      )}
      {status && (
        <p
          className={`recording-asset__status${error ? ' is-error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {status}
        </p>
      )}
    </div>
  );
}
