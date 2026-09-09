import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cameraCaptureConstraints,
  readCameraSettings,
  requestedCameraLabel,
  writeCameraSettings,
  type CameraSettings,
} from '@/media/cameraSettings';
import { deviceError, ensureDesktopPermission } from './deviceHelpers';

const actualLabel = (settings: MediaTrackSettings) =>
  settings.width && settings.height
    ? `${settings.width}×${settings.height}${settings.frameRate ? ` at ${Math.round(settings.frameRate)} FPS` : ''}`
    : 'not reported by this camera';

/**
 * A local camera preview and the quality it was actually granted.
 *
 * What a camera reports back rarely matches what was asked for, so the preview
 * reports both, and the capabilities it exposes gate the options in the form.
 */
export function useCameraPreview({
  alive,
  camera,
  refresh,
  onStatus,
}: {
  alive: React.RefObject<boolean>;
  camera: string;
  refresh: () => Promise<void>;
  onStatus: (status: string) => void;
}) {
  const [quality, setQuality] = useState(readCameraSettings);
  const [capabilities, setCapabilities] = useState<MediaTrackCapabilities | null>(null);
  const [actual, setActual] = useState<MediaTrackSettings | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef(0);

  const stop = useCallback(() => {
    request.current += 1;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setPreviewing(false);
  }, []);

  useEffect(() => stop, [stop]);

  /** Clears the reported capabilities so a new camera is not judged by the old one's. */
  const forget = useCallback(() => {
    stop();
    setCapabilities(null);
    setActual(null);
  }, [stop]);

  const start = useCallback(
    async (settings: CameraSettings = quality) => {
      stop();
      onStatus(`Starting ${requestedCameraLabel(settings)} preview…`);
      const current = ++request.current;
      const stale = () => !alive.current || current !== request.current;
      try {
        await ensureDesktopPermission('camera');
        if (stale()) return;
        const media = await navigator.mediaDevices.getUserMedia({
          video: cameraCaptureConstraints(camera, settings),
          audio: false,
        });
        if (stale()) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = media;
        const track = media.getVideoTracks()[0];
        if (!track) throw new Error('The camera preview did not produce video.');
        setActual(track.getSettings());
        setCapabilities(
          typeof track.getCapabilities === 'function' ? track.getCapabilities() : null,
        );
        if (video.current) {
          video.current.srcObject = media;
          await video.current.play();
        }
        if (stale()) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        setPreviewing(true);
        onStatus(
          `Requested ${requestedCameraLabel(settings)}. Actual ${actualLabel(track.getSettings())}. Camera preview is local and is not being recorded.`,
        );
        await refresh();
      } catch (error) {
        if (current === request.current) {
          stop();
          if (alive.current) onStatus(deviceError(error, 'camera'));
        }
      }
    },
    [alive, camera, quality, refresh, stop, onStatus],
  );

  const toggle = async () => {
    if (!previewing) return start();
    stop();
    onStatus('Preview stopped.');
  };

  /** A quality change applies to the call immediately and restarts a live preview. */
  const updateQuality = (next: CameraSettings) => {
    setQuality(next);
    writeCameraSettings(next);
    window.dispatchEvent(new Event('bc-camera-quality'));
    if (previewing) void start(next);
  };

  return { quality, updateQuality, capabilities, actual, previewing, video, toggle, forget };
}
