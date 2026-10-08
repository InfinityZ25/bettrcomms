import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, RotateCw } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerURL from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { MessageAttachment } from '@/api';
import { ApiRequestError } from '@/api';
import {
  apiAuthHeaders,
  apiCredentials,
  apiHttpUrl,
} from '@/desktop/apiTransport';
import {
  sessionExpired,
  sessionGeneration,
} from '@/features/auth/sessionEvents';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { attachmentSize } from './attachmentFiles';

function PDFPage({
  document,
  page,
}: {
  document: PDFDocumentProxy;
  page: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useMountEffect(() => {
    let active = true;
    let cancel: (() => void) | undefined;
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        if (!active || !canvas.current) return;
        const original = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(
          1.5,
          960 / original.width,
          Math.sqrt(4_000_000 / (original.width * original.height)),
        );
        const viewport = pdfPage.getViewport({ scale });
        canvas.current.width = Math.ceil(viewport.width);
        canvas.current.height = Math.ceil(viewport.height);
        // Canvas rendering never creates links, forms, annotation layers or a PDF
        // scripting environment. PDF.js 6 removed its eval code paths entirely.
        const render = pdfPage.render({
          canvas: canvas.current,
          viewport,
          annotationMode: 0,
        });
        cancel = () => render.cancel();
        await render.promise;
        if (active) setLoading(false);
      })
      .catch((failure: unknown) => {
        if (active) {
          setLoading(false);
          setError(
            failure instanceof Error
              ? failure.message
              : 'Could not render this page',
          );
        }
      });
    return () => {
      active = false;
      cancel?.();
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
    };
  });
  return (
    <div className="flex min-h-52 flex-col items-center gap-3">
      {loading && (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          Rendering PDF…
        </p>
      )}
      {error && (
        <p role="alert" className="p-6 text-sm">
          {error}
        </p>
      )}
      <canvas
        ref={canvas}
        role="img"
        aria-label={`PDF page ${page} of ${document.numPages}`}
        className="max-w-full bg-white shadow-sm"
        hidden={loading || !!error}
      />
    </div>
  );
}

function PDFDocument({
  roomId,
  attachment,
}: {
  roomId: string;
  attachment: MessageAttachment;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  useMountEffect(() => {
    const controller = new AbortController();
    const generation = sessionGeneration();
    let destroy: (() => Promise<void>) | undefined;
    const timer = setTimeout(() => {
      controller.abort();
      void destroy?.();
      setError('PDF preview timed out. Download the original file to view it.');
    }, 30_000);
    void (async () => {
      if (attachment.size_bytes > 20 * 1024 * 1024)
        throw new Error(
          'PDF previews support files up to 20 MB. Download the original file to view it.',
        );
      const response = await fetch(
        apiHttpUrl(`/api/v1/rooms/${roomId}/files/${attachment.id}/preview`),
        {
          credentials: apiCredentials(),
          headers: apiAuthHeaders(),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        if (response.status === 401) sessionExpired(generation);
        const body = (await response.json().catch(() => undefined)) as
          { error?: { message?: string; code?: string } } | undefined;
        throw new ApiRequestError(
          body?.error?.message ?? 'Could not open PDF',
          response.status,
          body?.error?.code,
        );
      }
      const bytes = await response.arrayBuffer();
      if (controller.signal.aborted || generation !== sessionGeneration())
        return;
      if (bytes.byteLength > 20 * 1024 * 1024)
        throw new Error('PDF preview exceeds the size limit');
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      if (controller.signal.aborted || generation !== sessionGeneration())
        return;
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerURL;
      const loading = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        enableXfa: false,
        useWasm: false,
        useWorkerFetch: false,
        disableAutoFetch: true,
        disableFontFace: true,
        maxImageSize: 16_000_000,
        canvasMaxAreaInBytes: 16_000_000,
      });
      destroy = () => loading.destroy();
      const loaded = await loading.promise;
      if (controller.signal.aborted || generation !== sessionGeneration()) {
        await loading.destroy();
        return;
      }
      clearTimeout(timer);
      setDocument(loaded);
    })()
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && generation === sessionGeneration())
          setError(
            failure instanceof Error ? failure.message : 'Could not open PDF',
          );
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
      void destroy?.();
    };
  });
  return (
    <>
      {!document && !error && (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          Opening PDF…
        </p>
      )}
      {error && (
        <p role="alert" className="p-6 text-sm">
          {error}
        </p>
      )}
      {document && (
        <>
          <div className="flex items-center justify-center gap-3 pb-3">
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Previous PDF page"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft />
            </Button>
            <span className="text-sm">
              Page {page} of {document.numPages}
            </span>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Next PDF page"
              disabled={page >= document.numPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
          <PDFPage key={page} document={document} page={page} />
        </>
      )}
    </>
  );
}

export default function PDFPreview({
  roomId,
  attachment,
  onClose,
  onDownload,
}: {
  roomId: string;
  attachment: MessageAttachment;
  onClose: () => void;
  onDownload: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={attachment.filename}
      description={`${attachmentSize(attachment.size_bytes)} · PDF preview`}
      className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-4xl"
    >
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAttempt(attempt + 1)}
        >
          <RotateCw />
          Retry preview
        </Button>
        <Button variant="outline" size="sm" onClick={onDownload}>
          <Download />
          Download
        </Button>
      </div>
      <div className="min-h-0 overflow-auto rounded-xl bg-muted/30 p-3">
        <PDFDocument
          key={`${roomId}:${attachment.id}:${attempt}`}
          roomId={roomId}
          attachment={attachment}
        />
      </div>
    </AppDialog>
  );
}
