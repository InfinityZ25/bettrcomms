import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Download, FileDown, LoaderCircle } from 'lucide-react';
import { saveRecordingAsset } from './media/recordingExport';
import './RecordingDownload.css';

export function RecordingDownload({
  file,
  label,
}: {
  file: { name: string; blob: Blob };
  label?: string;
}) {
  const desktop = isTauri();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const value = desktop ? '' : URL.createObjectURL(file.blob);
    setUrl(value);
    return () => {
      alive.current = false;
      controller.current?.abort();
      if (value) URL.revokeObjectURL(value);
    };
  }, [file.blob, desktop]);

  async function save() {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(false);
    setProgress(null);
    setStatus('Choose where to save this original file…');
    try {
      const saved = await saveRecordingAsset(file, request.signal, (value) => {
        if (alive.current) {
          setProgress(value);
          setStatus('Saving original file…');
        }
      });
      if (alive.current)
        setStatus(saved ? `Saved to ${saved.path}` : 'Save cancelled.');
    } catch (reason) {
      if (alive.current) {
        setError(!request.signal.aborted);
        setStatus(
          request.signal.aborted
            ? 'Save cancelled.'
            : `Could not save: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    } finally {
      controller.current = null;
      if (alive.current) {
        setBusy(false);
        setProgress(null);
      }
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
      {busy && progress !== null && (
        <button
          className="text-button"
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
