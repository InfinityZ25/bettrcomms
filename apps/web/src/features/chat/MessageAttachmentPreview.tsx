import { useCallback, useRef, useState } from 'react';
import {
  Download,
  File,
  FileVideo,
  Image,
  Maximize2,
  Mic,
  Music2,
  RotateCw,
} from 'lucide-react';
import type { MessageAttachment } from '@/api';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';
import {
  attachmentKind,
  attachmentSize,
  signedAttachmentURL,
} from './attachmentFiles';
import AttachmentViewer from './AttachmentViewer';
import { voiceNoteTime } from './voiceNoteRecorder';

type PreviewProps = {
  attachment: MessageAttachment;
  roomId: string;
  onError: (message: string) => void;
  onDownload: () => void;
};

/** A fresh authorization read happens every time an attachment is opened. */
function RemoteAttachmentViewer({
  attachment,
  roomId,
  onDownload,
  onClose,
}: PreviewProps & { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  const load = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setUrl('');
    setLoading(true);
    setError('');
    try {
      const fresh = await signedAttachmentURL(
        roomId,
        attachment.id,
        controller.signal,
      );
      if (active.current && !controller.signal.aborted) setUrl(fresh);
    } catch (failure) {
      if (active.current && !controller.signal.aborted)
        setError(errorMessage(failure));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (active.current) setLoading(false);
      }
    }
  };
  useMountEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      request.current?.abort();
    };
  });
  return (
    <AttachmentViewer
      filename={attachment.filename}
      description={`${attachmentSize(attachment.size_bytes)} · ${attachment.content_type}`}
      kind={attachmentKind(attachment.content_type)}
      url={url}
      loading={loading}
      error={error}
      onClose={onClose}
      onDownload={onDownload}
      onRetry={() => void load()}
      onMediaError={() => {
        setUrl('');
        setError(
          'This preview link may have expired, or your browser cannot play this format. Retry the preview or download the original file.',
        );
      }}
    />
  );
}

export default function MessageAttachmentPreview(props: PreviewProps) {
  return (
    <AttachmentPreview
      key={`${props.roomId}:${props.attachment.id}`}
      {...props}
    />
  );
}

function AttachmentPreview({
  attachment,
  roomId,
  onError,
  onDownload,
}: PreviewProps) {
  const kind = attachmentKind(attachment.content_type);
  const container = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const inflight = useRef(false);
  const expiresAt = useRef(0);
  const alive = useRef(true);
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

  const load = async () => {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    setFailed(false);
    const controller = new AbortController();
    request.current = controller;
    try {
      const fresh = await signedAttachmentURL(
        roomId,
        attachment.id,
        controller.signal,
      );
      if (!alive.current || controller.signal.aborted) return;
      expiresAt.current = Date.now() + 4 * 60_000 + 50_000;
      setUrl(fresh);
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
      setFailed(true);
      onError(errorMessage(error));
    } finally {
      if (request.current === controller) {
        request.current = null;
        inflight.current = false;
        if (alive.current) setLoading(false);
      }
    }
  };
  const failPreview = () => {
    if (!alive.current) return;
    media.current?.pause();
    setUrl('');
    setFailed(true);
  };
  useMountEffect(() => {
    alive.current = true;
    let observer: IntersectionObserver | undefined;
    if (kind === 'image') {
      if (container.current && 'IntersectionObserver' in window) {
        observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              observer?.disconnect();
              void load();
            }
          },
          { rootMargin: '160px' },
        );
        observer.observe(container.current);
      } else void load();
    }
    return () => {
      alive.current = false;
      request.current?.abort();
      inflight.current = false;
      observer?.disconnect();
      if (media.current) {
        media.current.pause();
        media.current.removeAttribute('src');
        media.current.load();
      }
    };
  });
  const Icon = attachment.voice_note
    ? Mic
    : kind === 'image'
      ? Image
      : kind === 'video'
        ? FileVideo
        : kind === 'audio'
          ? Music2
          : File;
  const openViewer = () => {
    media.current?.pause();
    setExpanded(true);
  };
  return (
    <div
      ref={container}
      className="min-w-0 max-w-full overflow-hidden rounded-xl border bg-muted/25"
      aria-label={`Attachment ${attachment.filename}`}
    >
      {kind === 'image' && url && (
        <button
          type="button"
          className="group/image relative block w-full bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open image ${attachment.filename}`}
          onClick={openViewer}
        >
          <img
            src={url}
            alt={attachment.filename}
            loading="lazy"
            className="max-h-80 w-full object-contain"
            onError={failPreview}
          />
          <span className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1 rounded-full border bg-background/90 px-2 py-1 text-xs opacity-0 transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none">
            <Maximize2 size={12} />
            Open image
          </span>
        </button>
      )}
      {kind === 'image' && !url && (
        <div className="flex min-h-28 items-center justify-center bg-muted/30 p-3">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? (
              'Loading image…'
            ) : failed ? (
              <>
                <RotateCw />
                Retry preview
              </>
            ) : (
              <>
                <Image />
                Preview image
              </>
            )}
          </Button>
        </div>
      )}
      {kind === 'video' && url && (
        <video
          ref={setMedia}
          key={url}
          src={url}
          controls
          preload="metadata"
          playsInline
          aria-label={attachment.filename}
          className="max-h-80 w-full bg-muted/40"
          onError={failPreview}
          onPlay={() => {
            if (Date.now() >= expiresAt.current) failPreview();
          }}
        />
      )}
      <div className="flex items-center gap-2 p-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon size={17} className="text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-xs font-medium"
            title={attachment.filename}
          >
            {attachment.voice_note
              ? `Voice note · ${voiceNoteTime(attachment.duration_ms ?? 0)}`
              : attachment.filename}
          </p>
          <p className="mt-0.5 text-[0.65rem] text-muted-foreground">
            {attachmentSize(attachment.size_bytes)}
            {kind === 'video' && ' · Video'}
            {kind === 'audio' && !attachment.voice_note && ' · Audio'}
          </p>
        </div>
        {(kind === 'image' || kind === 'video') && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="phone:size-11"
            aria-label={`Open ${attachment.filename}`}
            onClick={openViewer}
          >
            <Maximize2 />
          </Button>
        )}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="phone:size-11"
          aria-label={`Download ${attachment.filename}`}
          onClick={onDownload}
        >
          <Download />
        </Button>
      </div>
      {(kind === 'audio' || kind === 'video') && !url && (
        <div className="flex flex-col items-start gap-1 px-2.5 pb-2.5">
          {failed && (
            <p role="status" className="text-xs text-muted-foreground">
              The preview expired or this format could not be played. Download
              the original or retry.
            </p>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? (
              'Opening…'
            ) : failed ? (
              <>
                <RotateCw />
                Retry preview
              </>
            ) : kind === 'video' ? (
              <>
                <FileVideo />
                Watch video
              </>
            ) : (
              <>
                <Music2 />
                {attachment.voice_note
                  ? 'Listen to voice note'
                  : 'Listen to audio'}
              </>
            )}
          </Button>
        </div>
      )}
      {kind === 'audio' && url && (
        <div className="px-2.5 pb-2.5">
          <audio
            ref={setMedia}
            key={url}
            src={url}
            controls
            preload="none"
            aria-label={
              attachment.voice_note ? 'Play voice note' : attachment.filename
            }
            className="h-10 w-full"
            onError={failPreview}
            onPlay={() => {
              if (Date.now() >= expiresAt.current) failPreview();
            }}
          />
        </div>
      )}
      {expanded && (
        <RemoteAttachmentViewer
          attachment={attachment}
          roomId={roomId}
          onError={onError}
          onDownload={onDownload}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  );
}
