import { useCallback, useRef, useState } from 'react';
import { Download, Mic, Paperclip } from 'lucide-react';
import { api, type MessageAttachment } from '@/api';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';
import { voiceNoteTime } from './voiceNoteRecorder';

type PreviewProps = {
  attachment: MessageAttachment;
  roomId: string;
  onError: (message: string) => void;
  onDownload: () => void;
};

export default function MessageAttachmentPreview(props: PreviewProps) {
  return <AttachmentPreview key={`${props.roomId}:${props.attachment.id}`} {...props} />;
}

function AttachmentPreview({ attachment, roomId, onError, onDownload }: PreviewProps) {
  const kind = attachment.content_type.startsWith('image/') ? 'image'
    : attachment.content_type.startsWith('audio/') ? 'audio'
      : attachment.content_type.startsWith('video/') ? 'video' : 'file';
  const container = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inflight = useRef(false);
  const expiresAt = useRef(0);
  const refreshAttempted = useRef(false);
  const resumeAt = useRef<number | null>(null);
  const resumePlaying = useRef(false);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const setMediaRef = useCallback((element: HTMLMediaElement | null) => {
    const previous = mediaRef.current;
    if (previous && previous !== element) { previous.pause(); previous.removeAttribute('src'); previous.load(); }
    mediaRef.current = element;
    // React can replay a callback ref with the same DOM element in StrictMode.
    // Restore the source released by the preceding cleanup before playback.
    if (element && url && !element.getAttribute('src')) element.src = url;
  }, [url]);

  async function signedURL(signal: AbortSignal) {
    const result = await api<{ url: string }>(`/rooms/${roomId}/attachments/${attachment.id}?link=1&inline=1`, undefined, undefined, signal);
    const parsed = new URL(result.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Invalid attachment URL');
    return result.url;
  }
  async function load(resume?: HTMLMediaElement) {
    if (inflight.current) return;
    if (!resume) refreshAttempted.current = false;
    inflight.current = true;
    setLoading(true);
    setFailed(false);
    const controller = new AbortController();
    request.current = controller;
    try {
      const fresh = await signedURL(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      expiresAt.current = Date.now() + 4 * 60_000 + 50_000;
      if (resume) resumeAt.current = resume.currentTime;
      setUrl(fresh);
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
      resumeAt.current = null;
      if (resume) setUrl('');
      setFailed(true);
      onError(errorMessage(error));
    } finally {
      if (request.current === controller) { request.current = null; if (alive.current) { inflight.current = false; setLoading(false); } }
    }
  }
  function mediaError(media: HTMLMediaElement) {
    if (!alive.current || mediaRef.current !== media || inflight.current) return;
    if (Date.now() >= expiresAt.current && !refreshAttempted.current) {
      refreshAttempted.current = true;
      resumePlaying.current = !media.paused;
      void load(media);
    } else {
      resumeAt.current = null;
      setUrl('');
      setFailed(true);
    }
  }
  function mediaPlay(media: HTMLMediaElement) {
    if (!alive.current || mediaRef.current !== media) return;
    if (Date.now() < expiresAt.current || refreshAttempted.current) return;
    resumePlaying.current = true;
    media.pause();
    refreshAttempted.current = true;
    void load(media);
  }
  function mediaLoaded(media: HTMLMediaElement) {
    if (!alive.current || mediaRef.current !== media || resumeAt.current === null) return;
    const position = resumeAt.current;
    resumeAt.current = null;
    try { media.currentTime = position; } catch { /* Some streams do not support seeking. */ }
    if (resumePlaying.current) void media.play().catch(() => {});
    resumePlaying.current = false;
  }
  useMountEffect(() => {
    alive.current = true;
    let observer: IntersectionObserver | undefined;
    if (kind === 'image' && container.current && 'IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); void load(); }
      }, { rootMargin: '160px' });
      observer.observe(container.current);
    }
    return () => {
      alive.current = false;
      request.current?.abort();
      inflight.current = false;
      observer?.disconnect();
      if (mediaRef.current) { mediaRef.current.pause(); mediaRef.current.removeAttribute('src'); mediaRef.current.load(); }
    };
  });

  return (
    <div ref={container} className="max-w-full rounded-lg border bg-muted/30 p-2" aria-label={`Attachment ${attachment.filename}`}>
      <div className="flex items-center gap-2 text-xs">
        {attachment.voice_note ? <Mic size={13} className="shrink-0" /> : <Paperclip size={13} className="shrink-0" />}
        <span className="min-w-0 flex-1 truncate" title={attachment.filename}>{attachment.voice_note ? `Voice note · ${voiceNoteTime(attachment.duration_ms ?? 0)}` : attachment.filename}</span>
        <Button size="icon-sm" variant="ghost" aria-label={`Download ${attachment.filename}`} onClick={onDownload}><Download size={13} /></Button>
      </div>
      {kind !== 'file' && !url && (
        <Button size="sm" variant="ghost" className="mt-2" disabled={loading} onClick={() => void load()}>
          {loading ? 'Loading…' : failed ? 'Retry preview' : attachment.voice_note ? 'Listen to voice note' : `Show ${kind} preview`}
        </Button>
      )}
      {kind === 'image' && url && <img src={url} alt={attachment.filename} loading="lazy" className="mt-2 max-h-80 max-w-full rounded-md object-contain" onError={() => { setUrl(''); setFailed(true); }} />}
      {kind === 'audio' && url && <audio ref={setMediaRef} key={url} src={url} aria-label={attachment.voice_note ? 'Play voice note' : attachment.filename} controls preload={resumeAt.current === null ? 'none' : 'metadata'} className="mt-2 max-w-full" onPlay={(event) => mediaPlay(event.currentTarget)} onPlaying={() => { refreshAttempted.current = false; }} onLoadedMetadata={(event) => mediaLoaded(event.currentTarget)} onError={(event) => mediaError(event.currentTarget)} />}
      {kind === 'video' && url && <video ref={setMediaRef} key={url} src={url} controls preload={resumeAt.current === null ? 'none' : 'metadata'} playsInline className="mt-2 max-h-80 max-w-full rounded-md" onPlay={(event) => mediaPlay(event.currentTarget)} onPlaying={() => { refreshAttempted.current = false; }} onLoadedMetadata={(event) => mediaLoaded(event.currentTarget)} onError={(event) => mediaError(event.currentTarget)} />}
    </div>
  );
}
