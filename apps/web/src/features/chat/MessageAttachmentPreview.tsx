import { useRef, useState } from 'react';
import { Download, Paperclip } from 'lucide-react';
import { api, type MessageAttachment } from '@/api';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';

export default function MessageAttachmentPreview({ attachment, roomId, onError, onDownload }: {
  attachment: MessageAttachment;
  roomId: string;
  onError: (message: string) => void;
  onDownload: () => void;
}) {
  const kind = attachment.content_type.startsWith('image/') ? 'image'
    : attachment.content_type.startsWith('audio/') ? 'audio'
      : attachment.content_type.startsWith('video/') ? 'video' : 'file';
  const container = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inflight = useRef(false);
  const expiresAt = useRef(0);

  async function signedURL() {
    const result = await api<{ url: string }>(`/rooms/${roomId}/attachments/${attachment.id}?link=1&inline=1`);
    const parsed = new URL(result.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Invalid attachment URL');
    return result.url;
  }
  async function load(resume?: HTMLMediaElement) {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const fresh = await signedURL();
      expiresAt.current = Date.now() + 4 * 60_000;
      setUrl(fresh);
      if (resume) {
        resume.src = fresh;
        void resume.play().catch(() => {});
      }
    } catch (error) {
      if (resume) setUrl('');
      setFailed(true);
      onError(errorMessage(error));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }
  function mediaError(media: HTMLMediaElement) {
    if (Date.now() >= expiresAt.current) void load(media);
    else { setUrl(''); setFailed(true); }
  }
  function mediaPlay(media: HTMLMediaElement) {
    if (Date.now() < expiresAt.current) return;
    media.pause();
    void load(media);
  }
  useMountEffect(() => {
    if (kind !== 'image' || !container.current || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load();
      }
    }, { rootMargin: '160px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  });

  return (
    <div ref={container} className="max-w-full rounded-lg border bg-muted/30 p-2" aria-label={`Attachment ${attachment.filename}`}>
      <div className="flex items-center gap-2 text-xs">
        <Paperclip size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={attachment.filename}>{attachment.filename}</span>
        <Button size="icon-sm" variant="ghost" aria-label={`Download ${attachment.filename}`} onClick={onDownload}><Download size={13} /></Button>
      </div>
      {kind !== 'file' && !url && (
        <Button size="sm" variant="ghost" className="mt-2" disabled={loading} onClick={() => void load()}>
          {loading ? 'Loading…' : failed ? 'Retry preview' : `Show ${kind} preview`}
        </Button>
      )}
      {kind === 'image' && url && <img src={url} alt={attachment.filename} loading="lazy" className="mt-2 max-h-80 max-w-full rounded-md object-contain" onError={() => { setUrl(''); setFailed(true); }} />}
      {kind === 'audio' && url && <audio src={url} controls preload="none" className="mt-2 max-w-full" onPlay={(event) => mediaPlay(event.currentTarget)} onError={(event) => mediaError(event.currentTarget)} />}
      {kind === 'video' && url && <video src={url} controls preload="none" playsInline className="mt-2 max-h-80 max-w-full rounded-md" onPlay={(event) => mediaPlay(event.currentTarget)} onError={(event) => mediaError(event.currentTarget)} />}
    </div>
  );
}
