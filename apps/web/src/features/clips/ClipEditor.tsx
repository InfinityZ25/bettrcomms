import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { api, type MessageAttachment, type Room } from '@/api';
import {
  uploadResumableAttachment,
  cancelResumableUpload,
} from '@/features/chat/resumableUploads';
import { AppDialog } from '@/components/app-dialog';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import type { ClipWindow } from '@/media/clipBuffer';
import { clipTrackKey, renderClip } from '@/media/clipRenderer';
import { ClipSelectionControls } from './ClipSelectionControls';
import { ClipEditorActions } from './ClipEditorActions';

function ClipEditor({
  window,
  room,
  names,
  onClose,
}: {
  window: ClipWindow;
  room: Room;
  names: Record<string, string>;
  onClose: () => void;
}) {
  const duration = (window.endMs - window.startMs) / 1000;
  const sources = useMemo(() => {
    const sourceMap = new Map(
      window.segments.map((segment) => [clipTrackKey(segment), segment]),
    );
    return { keys: [...sourceMap.keys()], sourceMap };
  }, [window]);
  const { videoOptions, audioOptions } = useMemo(() => {
    const options = sources.keys.map((key) => {
      const { peerId, source } = sources.sourceMap.get(key)!;
      return {
        key,
        label: `${names[peerId] ?? 'Friend'} · ${source === 'system' ? 'shared audio' : source}`,
      };
    });
    return {
      videoOptions: options.filter((option) =>
        /:(screen|camera)$/.test(option.key),
      ),
      audioOptions: options.filter((option) =>
        /:(microphone|system)$/.test(option.key),
      ),
    };
  }, [sources, names]);
  const [video, setVideo] = useState(
    () =>
      videoOptions.find((option) => option.key.endsWith(':screen'))?.key ??
      videoOptions[0]?.key ??
      '',
  );
  const [audio, setAudio] = useState(() =>
    audioOptions.map((option) => option.key),
  );
  const [start, setStart] = useState(() => Math.max(0, duration - 30));
  const [end, setEnd] = useState(() => duration);
  const [title, setTitle] = useState(() => `${room.name} · clip`);
  const [busy, setBusy] = useState<'preview' | 'export' | 'publish' | null>(
    null,
  );
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const operation = useRef<AbortController | null>(null);
  const uploaded = useRef<MessageAttachment | null>(null);
  const uploadId = useRef<string | null>(null);
  const published = useRef(false);
  const active = useRef(true);
  const [nonce] = useState(() => ({ current: crypto.randomUUID() }));
  const canPublish = room.permissions?.post ?? true;

  const invalidate = useCallback(() => {
    setFile(null);
    const attachment = uploaded.current;
    uploaded.current = null;
    const upload = uploadId.current;
    uploadId.current = null;
    nonce.current = crypto.randomUUID();
    if (upload) void cancelResumableUpload(room.id, upload).catch(() => {});
    else if (attachment)
      void api(
        `/rooms/${room.id}/attachments/${attachment.id}`,
        undefined,
        'DELETE',
      ).catch(() => {});
  }, [room.id, nonce]);
  const changeStart = useCallback(
    (value: number) => {
      setStart(value);
      setEnd((current) => Math.min(current, value + 60));
      invalidate();
    },
    [invalidate],
  );
  const changeEnd = useCallback(
    (value: number) => {
      setEnd(value);
      invalidate();
    },
    [invalidate],
  );
  const changeVideo = useCallback(
    (key: string) => {
      setVideo(key);
      invalidate();
    },
    [invalidate],
  );
  const changeAudio = useCallback(
    (key: string, selected: boolean) => {
      setAudio((current) =>
        selected ? [...current, key] : current.filter((item) => item !== key),
      );
      invalidate();
    },
    [invalidate],
  );
  function cancel() {
    operation.current?.abort();
  }
  useMountEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      operation.current?.abort();
      const attachment = uploaded.current;
      if (!published.current) {
        if (uploadId.current)
          void cancelResumableUpload(room.id, uploadId.current).catch(() => {});
        else if (attachment)
          void api(
            `/rooms/${room.id}/attachments/${attachment.id}`,
            undefined,
            'DELETE',
          ).catch(() => {});
      }
    };
  });
  async function run(mode: 'preview' | 'export' | 'publish') {
    if (busy || !title.trim() || end <= start || end - start > 60) return;
    const abort = new AbortController();
    operation.current = abort;
    setBusy(mode);
    setError('');
    setProgress(0);
    try {
      let result = file;
      if (mode === 'preview' || !result) {
        const blob = await renderClip({
          window,
          startMs: window.startMs + start * 1000,
          endMs: window.startMs + end * 1000,
          videoKey: video || undefined,
          audioKeys: audio,
          title: title.trim(),
          signal: abort.signal,
          canvas: canvas.current ?? undefined,
          preview: mode === 'preview',
          onProgress: (value) => {
            if (active.current) setProgress(value);
          },
        });
        if (blob) {
          result = new File(
            [blob],
            `clip-${Date.now()}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`,
            { type: blob.type },
          );
          if (active.current) setFile(result);
        }
      }
      abort.signal.throwIfAborted();
      if (mode === 'publish' && result) {
        if (!uploaded.current)
          uploaded.current = await uploadResumableAttachment(room.id, result, {
            signal: abort.signal,
            onProgress: (value) => {
              if (active.current) setProgress(value / 100);
            },
            onSession: (id) => {
              uploadId.current = id;
            },
            resumeId: uploadId.current ?? undefined,
          });
        abort.signal.throwIfAborted();
        await api(
          `/rooms/${room.id}/messages`,
          {
            body: `🎬 ${title.trim()}`,
            attachment_ids: [uploaded.current.id],
            client_nonce: nonce.current,
          },
          'POST',
          abort.signal,
        );
        published.current = true;
        if (active.current) onClose();
      }
    } catch (failure) {
      if (active.current && !abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (operation.current === abort) operation.current = null;
      if (active.current) setBusy(null);
    }
  }
  function download() {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          cancel();
          onClose();
        }
      }}
      title="Create clip"
      description={`Choose a moment, preview it and share it in ${room.name}.`}
      className="max-h-[90dvh] max-w-3xl overflow-y-auto"
    >
      <div className="space-y-4">
        <canvas
          ref={canvas}
          className="aspect-video w-full rounded-xl bg-[#101419]"
          aria-label="Clip preview"
        />
        <label className="block space-y-1 text-sm">
          Title
          <Input
            aria-label="Clip title"
            value={title}
            maxLength={120}
            disabled={!!busy}
            onChange={(event) => {
              setTitle(event.target.value);
              invalidate();
            }}
          />
        </label>
        <ClipSelectionControls
          duration={duration}
          start={start}
          end={end}
          video={video}
          audio={audio}
          videoOptions={videoOptions}
          audioOptions={audioOptions}
          disabled={!!busy}
          onStartChange={changeStart}
          onEndChange={changeEnd}
          onVideoChange={changeVideo}
          onAudioChange={changeAudio}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {busy && (
          <div role="status" className="space-y-1 text-sm">
            <p>
              {busy === 'preview'
                ? 'Previewing'
                : busy === 'publish'
                  ? 'Preparing and publishing clip'
                  : 'Rendering clip'}{' '}
              · {Math.round(progress * 100)}%
            </p>
            <progress
              aria-label="Clip progress"
              value={progress}
              max={1}
              className="h-1 w-full"
            />
            <p className="text-xs text-muted-foreground">
              Video export takes about the length of your clip.
            </p>
          </div>
        )}
        <ClipEditorActions
          busy={!!busy}
          hasFile={!!file}
          canPublish={canPublish && !!title.trim()}
          onCancel={cancel}
          onDownload={download}
          onRun={run}
        />
      </div>
    </AppDialog>
  );
}

export default memo(ClipEditor);
