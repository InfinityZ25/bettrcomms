import { useCallback, useEffect, useRef, useState } from 'react';
import {
  captureCameraWithFallback,
  readCameraSettings,
  requestedCameraLabel,
  writeCameraSettings,
  type CameraSettings,
} from '@/media/cameraSettings';
import { deviceError, ensureDesktopPermission } from './deviceHelpers';
import { META_GLASSES_CAMERA_ID, reconnectMetaGlassesCamera, startMetaGlassesCamera } from '@/media/metaGlassesCamera';

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
  const [connecting, setConnecting] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const nativeCleanup = useRef<(() => void) | null>(null);
  const request = useRef(0);

  const stop = useCallback(() => {
    request.current += 1;
    pending.current?.abort();
    pending.current = null;
    nativeCleanup.current?.();
    nativeCleanup.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setPreviewing(false);
    setConnecting(false);
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
      onStatus(camera === META_GLASSES_CAMERA_ID
        ? 'Connecting to Ray-Ban Meta glasses…'
        : `Starting ${requestedCameraLabel(settings)} preview…`);
      const current = ++request.current;
      const controller = new AbortController();
      pending.current = controller;
      setConnecting(true);
      const stale = () => !alive.current || current !== request.current;
      try {
        let media: MediaStream;
        let cleanup: (() => void) | null = null;
        if (camera === META_GLASSES_CAMERA_ID) {
          const glasses = await startMetaGlassesCamera(controller.signal);
          if (stale()) { glasses.dispose(); return; }
          cleanup = glasses.dispose;
          media = new MediaStream([glasses.track]);
        } else {
          await ensureDesktopPermission('camera');
          if (stale()) return;
          media = await captureCameraWithFallback(
            (video) => navigator.mediaDevices.getUserMedia({ video, audio: false }),
            camera,
            settings,
          );
        }
        if (stale()) {
          cleanup?.();
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        nativeCleanup.current = cleanup;
        stream.current = media;
        const track = media.getVideoTracks()[0];
        if (!track) throw new Error('The camera preview did not produce video.');
        track.addEventListener('ended', () => {
          if (stream.current !== media) return;
          stop();
          if (alive.current) onStatus('Camera preview stopped. Select it again to reconnect.');
        }, { once: true });
        setActual(track.getSettings());
        setCapabilities(
          typeof track.getCapabilities === 'function' ? track.getCapabilities() : null,
        );
        if (video.current) {
          video.current.srcObject = media;
          await video.current.play();
        }
        if (stale()) {
          cleanup?.();
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        setPreviewing(true);
        onStatus(camera === META_GLASSES_CAMERA_ID
          ? 'Ray-Ban Meta preview is local and is not being recorded.'
          : `Requested ${requestedCameraLabel(settings)}. Actual ${actualLabel(track.getSettings())}. Camera preview is local and is not being recorded.`);
        await refresh();
      } catch (error) {
        if (current === request.current) {
          stop();
          if (alive.current) onStatus(deviceError(error, 'camera'));
        }
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          if (alive.current) setConnecting(false);
        }
      }
    },
    [alive, camera, quality, refresh, stop, onStatus],
  );

  const toggle = async () => {
    if (!previewing && !pending.current) return start();
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

  const [reconnecting, setReconnecting] = useState(false);
  const reconnect = async () => {
    if (reconnecting) return;
    stop();
    setReconnecting(true);
    const controller = new AbortController();
    pending.current = controller;
    onStatus('Reconnecting through Meta AI. Approve the new connection, then return here.');
    try {
      await reconnectMetaGlassesCamera(controller.signal);
      if (alive.current) onStatus('Meta connection renewed. Try Preview camera.');
    } catch (error) {
      if (alive.current) onStatus(deviceError(error, 'camera'));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (alive.current) setReconnecting(false);
    }
  };

  return { reconnect, reconnecting, quality, updateQuality, capabilities, actual, previewing, connecting, video, toggle, forget };
}
