import { useCallback, useRef, useState } from 'react';
import {
  Check,
  File,
  FileVideo,
  Image,
  Mic,
  Music2,
  Pencil,
  RotateCw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { cn } from '@/lib/utils';
import {
  attachmentKind,
  attachmentSize,
  signedAttachmentURL,
} from './attachmentFiles';
import AttachmentViewer from './AttachmentViewer';
import type { PendingAttachment } from './drafts';
import { voiceNoteTime } from './voiceNoteRecorder';

export default function PendingAttachmentCard({
  attachment,
  roomId,
  removable,
  retryable,
  onRemove,
  onCancel,
  onRetry,
  onEdit,
}: {
  attachment: PendingAttachment;
  roomId?: string;
  removable: boolean;
  retryable: boolean;
  onRemove: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onEdit?: () => void;
}) {
  const kind = attachmentKind(attachment.content_type, attachment.filename);
  const [url, setUrl] = useState('');
  const [previewError, setPreviewError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  const media = useRef<HTMLMediaElement | null>(null);
  const setMedia = useCallback(
    (element: HTMLMediaElement | null) => {
      const previous = media.current;
      if (previous && previous !== element) {
        previous.pause();
        previous.removeAttribute('src');
        previous.load();
      }
      media.current = element;
      if (element && url && !element.getAttribute('src')) element.src = url;
    },
    [url],
  );
  const loadRemotePreview = async () => {
    if (!roomId || !attachment.id || attachment.file) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPreviewLoading(true);
    setPreviewError(false);
    try {
      const fresh = await signedAttachmentURL(
        roomId,
        attachment.id,
        controller.signal,
      );
      if (active.current && !controller.signal.aborted) setUrl(fresh);
    } catch {
      if (active.current && !controller.signal.aborted) setPreviewError(true);
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (active.current) setPreviewLoading(false);
      }
    }
  };
  useMountEffect(() => {
    active.current = true;
    const localURL =
      attachment.file && kind !== 'file'
        ? URL.createObjectURL(attachment.file)
        : '';
    if (localURL) setUrl(localURL);
    else if (kind !== 'file') void loadRemotePreview();
    return () => {
      active.current = false;
      request.current?.abort();
      if (media.current) {
        media.current.pause();
        media.current.removeAttribute('src');
        media.current.load();
      }
      if (localURL) URL.revokeObjectURL(localURL);
    };
  });
  const uploading = attachment.uploadState === 'uploading';
  const ready = Boolean(attachment.id);
  const failed =
    attachment.uploadState === 'failed' ||
    attachment.uploadState === 'cancelled';
  const Icon = attachment.voice_note
    ? Mic
    : kind === 'image'
      ? Image
      : kind === 'video'
        ? FileVideo
        : kind === 'audio'
          ? Music2
          : File;
  const status = uploading
    ? attachment.progress === 100
      ? 'Finishing upload…'
      : `Uploading · ${attachment.progress ?? 0}%`
    : failed
      ? attachment.uploadError || 'Upload paused. Retry when ready.'
      : ready
        ? 'Uploaded · ready to send'
        : 'Ready to upload';
  return (
    <div
      className={cn(
        'relative min-w-0 overflow-hidden rounded-xl border border-border bg-background/70 shadow-[var(--highlight)] transition-colors',
        failed && 'border-destructive/40 bg-destructive/5',
      )}
      aria-label={`Pending attachment ${attachment.filename}`}
    >
      {kind === 'image' && url && !previewError && (
        <button
          type="button"
          className="block h-28 w-full bg-muted/40 transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          aria-label={`Preview ${attachment.filename}`}
          onClick={() => {
            setExpanded(true);
            if (!attachment.file) void loadRemotePreview();
          }}
        >
          <img
            src={url}
            alt={attachment.filename}
            className="h-full w-full object-contain"
            onError={() => setPreviewError(true)}
          />
        </button>
      )}
      {kind === 'video' && url && !previewError && (
        <video
          ref={setMedia}
          src={url}
          controls
          playsInline
          preload="metadata"
          className="h-28 w-full bg-muted/40 object-contain"
          aria-label={`Preview ${attachment.filename}`}
          onError={() => setPreviewError(true)}
        />
      )}
      {(kind === 'file' || !url || previewError) && (
        <div className="flex h-16 items-center justify-center bg-muted/50 text-primary">
          <Icon aria-hidden size={24} />
        </div>
      )}
      <div className="flex flex-col gap-1.5 p-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span
            title={attachment.filename}
            className="min-w-0 flex-1 truncate text-xs font-semibold"
          >
            {attachment.voice_note
              ? `Voice note · ${voiceNoteTime(attachment.duration_ms ?? 0)}`
              : attachment.filename}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-md text-muted-foreground hover:bg-destructive/12 hover:text-destructive"
            disabled={!removable}
            aria-label={`Remove ${attachment.filename}`}
            onClick={onRemove}
          >
            <X />
          </Button>
        </div>
        <div className="text-[0.6875rem] text-muted-foreground tabular-nums">
          {attachmentSize(attachment.size_bytes)}
          {previewError && ' · Preview unavailable; file can still be sent'}
        </div>
        {attachment.file && onEdit && (kind === 'image' || attachment.file.type.startsWith('image/')) && (
          <Button type="button" variant="outline" className="min-h-11" disabled={!removable || !retryable || uploading} aria-label={`Edit image ${attachment.filename}`} onClick={onEdit}>
            <Pencil data-icon="inline-start" />Edit image
          </Button>
        )}
        {previewLoading && (
          <p role="status" className="text-[0.6875rem] text-muted-foreground">
            Loading preview…
          </p>
        )}
        {previewError && ready && !attachment.file && kind !== 'file' && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={previewLoading}
            onClick={() => void loadRemotePreview()}
          >
            <RotateCw />
            Retry preview
          </Button>
        )}
        {kind === 'audio' && url && !previewError && (
          <audio
            ref={setMedia}
            src={url}
            controls
            preload="none"
            aria-label={`Preview ${attachment.filename}`}
            className="h-9 w-full min-w-0"
            onError={() => setPreviewError(true)}
          />
        )}
        <p
          role={failed ? 'alert' : 'status'}
          className={cn(
            'flex items-start gap-1 text-[0.6875rem] tabular-nums',
            failed ? 'text-destructive' : 'text-muted-foreground',
            ready && !failed && '[&>svg]:text-primary',
          )}
        >
          {ready && <Check size={12} className="shrink-0" />}
          {status}
        </p>
        {uploading && (
          <>
            <progress
              max={100}
              value={attachment.progress ?? 0}
              aria-label={`Upload progress for ${attachment.filename}`}
              className="h-1.5 w-full appearance-none overflow-hidden rounded-full bg-muted accent-primary [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width]"
            />
            <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
              Cancel upload
            </Button>
          </>
        )}
        {failed && attachment.file && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={!retryable}
            onClick={onRetry}
          >
            <RotateCw />
            Retry file
          </Button>
        )}
        {!attachment.file && !ready && (
          <p role="alert" className="text-xs text-destructive">
            Choose this file again.
          </p>
        )}
      </div>
      {expanded && (
        <AttachmentViewer
          filename={attachment.filename}
          description={`${attachment.file ? 'Local preview' : 'Uploaded attachment'} · ${attachmentSize(attachment.size_bytes)} · not sent yet`}
          kind={kind}
          url={url}
          loading={previewLoading}
          error={
            previewError
              ? 'This file cannot be previewed by your browser, or the preview link has expired.'
              : undefined
          }
          onRetry={
            !attachment.file ? () => void loadRemotePreview() : undefined
          }
          onClose={() => setExpanded(false)}
          onMediaError={() => setPreviewError(true)}
        />
      )}
    </div>
  );
}
