import { useEffect, useRef, useState } from 'react';
import {
  Clapperboard,
  ArrowLeft,
  Download,
  Trash2,
  Play,
  HardDrive,
} from 'lucide-react';
import { Mascot } from '@/components/mascot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RecordingPlayer } from './RecordingPlayer';
import { RecordingDownload } from './RecordingDownload';
import {
  listRecordings,
  loadRecording,
  deleteRecording,
  renameRecording,
  type SavedRecording,
} from '@/media/recordingLibrary';
import type { RecordingResult } from '@/media/types';
import './RecordingsLibrary.css';

/** 1:05, or 1:02:30 once there is an hour of it. */
function duration(ms: number) {
  const total = Math.round(ms / 1000);
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** The reader's own locale, to the minute. A recording's seconds are noise. */
const when = (at: string) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function RecordingsLibrary() {
  const requestId = useRef(0);
  const [items, setItems] = useState<SavedRecording[]>([]);
  const [selected, setSelected] = useState<{
    summary: SavedRecording;
    result: RecordingResult;
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState('');
  const [title, setTitle] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void listRecordings()
        .then((r) => {
          if (active) setItems(r);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    };
    refresh();
    window.addEventListener('bc-recordings-changed', refresh);
    return () => {
      active = false;
      requestId.current++;
      window.removeEventListener('bc-recordings-changed', refresh);
    };
  }, []);
  async function show(id: string) {
    const request = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const recording = await loadRecording(id);
      if (request !== requestId.current) return;
      setSelected(recording);
      setTitle(recording.summary.title);
    } catch (e) {
      if (request === requestId.current) setError(String(e));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }
  return (
    <div className="recordings-page">
      {items.length > 0 && (
        <p className="library-storage">
          <HardDrive size={14} />
          {items.length} {items.length === 1 ? 'recording' : 'recordings'} ·{' '}
          {(items.reduce((total, item) => total + item.bytes, 0) / 1048576).toFixed(1)}{' '}
          MB · on this device only, so export a copy before clearing app data.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Opening recording…</p>}
      {selected ? (
        <>
          <div className="library-player-heading">
            <Button variant="ghost" onClick={() => setSelected(null)}>
              <ArrowLeft size={16} /> All recordings
            </Button>
            <form
              className="recording-title-form"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await renameRecording(selected.summary.id, title);
                  setSelected({
                    ...selected,
                    summary: { ...selected.summary, title: title.trim() },
                  });
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              <Input
                aria-label="Recording title"
                value={title}
                maxLength={120}
                required
                onChange={(e) => setTitle(e.target.value)}
              />
              <Button variant="secondary" type="submit">
                Rename
              </Button>
            </form>
          </div>
          <RecordingPlayer
            key={selected.summary.id}
            result={selected.result}
            labels={selected.summary.labels}
          />
          <details className="recording-exports">
            <summary>
              <Download size={16} /> Export tracks & timing manifest
            </summary>
            <p>
              Download original tracks or convert a copy to another format. Each track stays separate; playback volume changes do not affect exports.
            </p>
            {selected.result.files.map((file) => (
              <RecordingDownload
                key={file.name}
                file={file}
                mediaKind={selected.result.manifest.tracks.find(track => track.fileName === file.name)?.mediaKind}
                label={
                  file.name === 'manifest.json'
                    ? 'Timing manifest'
                    : (() => {
                        const track = selected.result.manifest.tracks.find(
                          (t) => t.fileName === file.name,
                        );
                        return track
                          ? `${selected.summary.labels[track.peerId] ?? 'Participant'} · ${track.source === 'system' ? 'system audio' : track.source}`
                          : undefined;
                      })()
                }
              />
            ))}
          </details>
        </>
      ) : (
        <div className="library-grid">
          {items.length === 0 && !loading ? (
            <div className="library-empty">
              <Mascot className="mx-auto w-20" />
              <h2>Nothing recorded yet.</h2>
              <p>
                Record a call or a screen share. What comes back lands here, with
                a separate mixer for every voice.
              </p>
            </div>
          ) : (
            items.map((item) => (
              <article className="library-card" key={item.id}>
                {/* Cover and title are one target. Two adjacent controls that
                    do the same thing is a choice nobody has to make. */}
                <button
                  type="button"
                  className="library-open"
                  onClick={() => void show(item.id)}
                  disabled={loading}
                >
                  <span className="library-cover">
                    <Clapperboard size={24} aria-hidden="true" />
                    <span className="library-play">
                      <Play size={18} fill="currentColor" aria-hidden="true" />
                    </span>
                  </span>
                  <span className="library-meta">
                    <strong>{item.title}</strong>
                    <time dateTime={item.startedAt}>
                      {when(item.startedAt)}
                    </time>
                    <span className="library-facts">
                      <span>{duration(item.durationMs)}</span>
                      <span>
                        {item.trackCount} {item.trackCount === 1 ? 'track' : 'tracks'}
                      </span>
                      <span>{(item.bytes / 1048576).toFixed(1)} MB</span>
                    </span>
                  </span>
                </button>
                {pendingDelete === item.id ? (
                  <div className="library-delete">
                    <span>Delete this recording for good?</span>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={async () => {
                        try {
                          await deleteRecording(item.id);
                          setPendingDelete('');
                        } catch (e) {
                          setError(String(e));
                        }
                      }}
                    >
                      Delete
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPendingDelete('')}
                    >
                      Keep it
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="library-remove"
                    onClick={() => setPendingDelete(item.id)}
                    aria-label={'Delete ' + item.title}
                  >
                    <Trash2 size={15} />
                  </Button>
                )}
              </article>
            ))
          )}
        </div>
      )}
    </div>
  );
}
