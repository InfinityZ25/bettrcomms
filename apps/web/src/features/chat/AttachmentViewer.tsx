import { useCallback, useRef, useState } from 'react';
import { Download, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { cn } from '@/lib/utils';
import type { AttachmentKind } from './attachmentFiles';

export default function AttachmentViewer({
  filename,
  description,
  kind,
  url,
  loading,
  error,
  onClose,
  onRetry,
  onDownload,
  onMediaError,
}: {
  filename: string;
  description: string;
  kind: AttachmentKind;
  url: string;
  loading?: boolean;
  error?: string;
  onClose: () => void;
  onRetry?: () => void;
  onDownload?: () => void;
  onMediaError: () => void;
}) {
  const [actualSize, setActualSize] = useState(false);
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
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
  useMountEffect(() => () => {
    if (media.current) {
      media.current.pause();
      media.current.removeAttribute('src');
      media.current.load();
    }
    const element = returnFocus.current;
    requestAnimationFrame(() => {
      if (element?.isConnected) element.focus();
    });
  });
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={filename}
      description={description}
      className="max-h-[calc(100dvh-2rem)] gap-3 overflow-hidden p-4 sm:max-w-5xl motion-reduce:transition-none [&_[data-slot=dialog-header]]:min-w-0 [&_[data-slot=dialog-header]]:pr-10 [&_[data-slot=dialog-title]]:truncate"
    >
      <div className="flex items-center justify-between gap-2">
        {kind === 'image' && url && !error ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setActualSize((value) => !value)}
            aria-pressed={actualSize}
          >
            {actualSize ? <ZoomOut /> : <ZoomIn />}
            {actualSize ? 'Fit to window' : 'Actual size'}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {kind === 'video'
              ? 'Video preview'
              : kind === 'audio'
                ? 'Audio preview'
                : 'Image preview'}
          </span>
        )}
        {onDownload && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onDownload}
          >
            <Download />
            Download
          </Button>
        )}
      </div>
      <div className="flex min-h-40 max-h-[70dvh] min-w-0 items-start justify-center overflow-auto rounded-xl bg-muted/40 p-2">
        {loading && (
          <p
            role="status"
            className="self-center p-6 text-sm text-muted-foreground"
          >
            Opening preview…
          </p>
        )}
        {error && (
          <div className="flex self-center flex-col items-center gap-3 p-6 text-center">
            <p role="alert" className="max-w-md text-sm text-muted-foreground">
              {error}
            </p>
            {onRetry && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onRetry}
              >
                <RotateCw />
                Retry preview
              </Button>
            )}
          </div>
        )}
        {!loading && !error && url && kind === 'image' && (
          <img
            src={url}
            alt={filename}
            className={cn(
              'shrink-0 rounded-md object-contain',
              actualSize ? 'max-h-none max-w-none' : 'max-h-[65dvh] max-w-full',
            )}
            onError={onMediaError}
          />
        )}
        {!loading && !error && url && kind === 'video' && (
          <video
            ref={setMedia}
            key={url}
            src={url}
            controls
            playsInline
            preload="metadata"
            aria-label={filename}
            className="max-h-[65dvh] max-w-full rounded-md"
            onError={onMediaError}
          />
        )}
        {!loading && !error && url && kind === 'audio' && (
          <audio
            ref={setMedia}
            key={url}
            src={url}
            controls
            preload="none"
            aria-label={filename}
            className="my-8 w-full max-w-xl"
            onError={onMediaError}
          />
        )}
      </div>
    </AppDialog>
  );
}
