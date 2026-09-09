import { useEffect, useRef, useState } from 'react';

/**
 * A still frame from a screen share nobody is watching right now.
 *
 * The track keeps arriving whether or not this tile paints it, so freezing the
 * picture must not tear the decoder down. A detached decoder needs a keyframe
 * when watching resumes, and a native sender cannot supply one on request,
 * which stalls the resumed view until the next scheduled IDR. Keep decoding
 * into the offscreen element and show the captured frame instead.
 */
export default function FrozenTrackPreview({
  track,
  name,
}: {
  track: MediaStreamTrack;
  name: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    const source = video.current;
    const target = canvas.current;
    if (!source || !target) return;
    let active = true;
    let captured = false;
    let frameRequest: number | undefined;
    const fallbackTimer = window.setTimeout(() => {
      if (active && !captured) setStatus('unavailable');
    }, 8_000);
    const capture = () => {
      if (!active || captured || !source.videoWidth || !source.videoHeight) return;
      captured = true;
      const scale = Math.min(1, 720 / source.videoWidth, 405 / source.videoHeight);
      target.width = Math.max(1, Math.round(source.videoWidth * scale));
      target.height = Math.max(1, Math.round(source.videoHeight * scale));
      target
        .getContext('2d', { alpha: false })
        ?.drawImage(source, 0, 0, target.width, target.height);
      setStatus('ready');
    };
    const queueCapture = () => {
      if (source.requestVideoFrameCallback)
        frameRequest = source.requestVideoFrameCallback(capture);
      else window.setTimeout(capture, 0);
    };
    source.srcObject = new MediaStream([track]);
    source.addEventListener('loadeddata', queueCapture, { once: true });
    void source.play().catch(() => {
      if (active) setStatus('unavailable');
    });
    return () => {
      active = false;
      clearTimeout(fallbackTimer);
      if (frameRequest !== undefined && source.cancelVideoFrameCallback)
        source.cancelVideoFrameCallback(frameRequest);
      source.removeEventListener('loadeddata', queueCapture);
      source.pause();
      source.srcObject = null;
    };
  }, [track]);

  return (
    <div className="frozen-track-preview" data-preview-ready={status === 'ready'}>
      <canvas ref={canvas} aria-label={`Preview of ${name}`} />
      {status === 'loading' && <span>Preparing preview…</span>}
      {status === 'unavailable' && <span>Preview unavailable</span>}
      <video ref={video} muted playsInline aria-hidden="true" />
    </div>
  );
}
