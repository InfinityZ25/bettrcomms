import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Plays one live track. Screen shares also report whether frames are actually
 * arriving, because a connected peer that sends nothing looks identical to a
 * black screen until the status says otherwise.
 */
export default function TrackVideo({
  track,
  self = false,
  showStatus = false,
  onReceiving,
  onAspectRatio,
}: {
  track: MediaStreamTrack;
  self?: boolean;
  showStatus?: boolean;
  onReceiving?: (receiving: boolean) => void;
  onAspectRatio?: (ratio: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const receivingCallback = useRef(onReceiving);
  receivingCallback.current = onReceiving;
  const aspectCallback = useRef(onAspectRatio);
  aspectCallback.current = onAspectRatio;
  const [videoStatus, setVideoStatus] = useState('Waiting for video frames…');
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let active = true;
    setVideoStatus('Waiting for video frames…');
    receivingCallback.current?.(false);
    video.srcObject = new MediaStream([track]);
    const metadata = () => {
      if (video.videoWidth && video.videoHeight)
        aspectCallback.current?.(
          Math.max(0.4, Math.min(2.4, video.videoWidth / video.videoHeight)),
        );
    };
    video.addEventListener('loadedmetadata', metadata);
    video.addEventListener('resize', metadata);
    void video.play().catch(() => {
      if (active) setVideoStatus('Video playback needs another attempt.');
    });
    const started = performance.now();
    let lastFrame = 0,
      lastProgress = started;
    const check = showStatus
      ? setInterval(() => {
          const frames =
            video.getVideoPlaybackQuality?.().totalVideoFrames ??
            (video.readyState >= 2 ? 1 : 0);
          if (frames > lastFrame) {
            lastFrame = frames;
            lastProgress = performance.now();
            setVideoStatus('');
            receivingCallback.current?.(true);
          } else if (performance.now() - lastProgress > 12_000) {
            setVideoStatus(
              lastFrame
                ? 'Screen video has stopped arriving. Ask the sender to restart sharing.'
                : 'No video frames have arrived. Ask the sender to restart or try browser sharing.',
            );
            receivingCallback.current?.(false);
          }
        }, 1000)
      : undefined;
    return () => {
      active = false;
      clearInterval(check);
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('resize', metadata);
      video.srcObject = null;
    };
  }, [track, showStatus]);
  return (
    <>
      <video ref={ref} autoPlay playsInline muted className={self ? 'self-video' : ''} />
      {showStatus && videoStatus && (
        <div
          role="status"
          style={{
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: 16,
            display: 'grid',
            placeContent: 'center',
            gap: 12,
            padding: 16,
            borderRadius: 12,
            textAlign: 'center',
            background: '#101414e6',
          }}
        >
          <span>{videoStatus}</span>
          <Button
            variant="secondary"
            onClick={() => {
              void ref.current
                ?.play()
                .catch(() =>
                  setVideoStatus(
                    'Could not start video playback. Check connection details below.',
                  ),
                );
            }}
          >
            Retry playback
          </Button>
        </div>
      )}
    </>
  );
}
