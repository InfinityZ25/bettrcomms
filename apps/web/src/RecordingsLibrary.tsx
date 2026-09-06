import { useEffect, useRef, useState } from 'react';
import {
  Clapperboard,
  ArrowLeft,
  Download,
  Trash2,
  Play,
  HardDrive,
} from 'lucide-react';
import { Button } from './components/ui/button';
import { RecordingPlayer } from './RecordingPlayer';
import { RecordingDownload } from './RecordingDownload';
import {
  listRecordings,
  loadRecording,
  deleteRecording,
  renameRecording,
  type SavedRecording,
} from './media/recordingLibrary';
import type { RecordingResult } from './media/types';
import './RecordingsLibrary.css';

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
      <div className="library-storage">
        <HardDrive size={16} />
        <span>
          Saved on this device, across restarts. Export a backup before clearing
          app or browser data.
        </span>
      </div>
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
              <input
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
              <Clapperboard size={40} />
              <h2>Keep the good parts.</h2>
              <p>
                Record a call or screen share. Once stopped, it appears here
                with a separate mixer for every voice.
              </p>
            </div>
          ) : (
            items.map((item) => (
              <article className="library-card" key={item.id}>
                <button
                  className="library-open"
                  onClick={() => void show(item.id)}
                  disabled={loading}
                >
                  <span className="library-cover">
                    <Clapperboard size={32} />
                    <span>
                      <Play size={20} /> Open recording
                    </span>
                  </span>
                  <strong>{item.title}</strong>
                  <time>{new Date(item.startedAt).toLocaleString()}</time>
                  <small>
                    {Math.round(item.durationMs / 1000)} sec · {item.trackCount}{' '}
                    tracks · {(item.bytes / 1048576).toFixed(1)} MB
                  </small>
                </button>
                {pendingDelete === item.id ? (
                  <div className="library-delete">
                    <span>Delete permanently?</span>
                    <Button
                      variant="danger"
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
                      variant="ghost"
                      onClick={() => setPendingDelete('')}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => setPendingDelete(item.id)}
                    aria-label={'Delete ' + item.title}
                  >
                    <Trash2 size={14} /> Delete
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
