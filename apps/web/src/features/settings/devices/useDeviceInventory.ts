import { useCallback, useEffect, useRef, useState } from 'react';
import { isWindowsDesktop } from '@/media/permissions';
import { invoke } from '@tauri-apps/api/core';
import { readStored, writeStored } from '@/lib/storage';
import { deviceError, ensureDesktopPermission, type PermissionKind } from './deviceHelpers';

/**
 * The device list and the selected input, output and camera.
 *
 * Device labels stay blank until capture has been permitted once, so enabling a
 * device is really a request for permission followed by a re-enumeration.
 */
export function useDeviceInventory({
  alive,
  onMicrophoneStatus,
  onCameraStatus,
}: {
  alive: React.RefObject<boolean>;
  onMicrophoneStatus: (status: string) => void;
  onCameraStatus: (status: string) => void;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [windowsDesktop, setWindowsDesktop] = useState(false);
  const [input, setInput] = useState(() => readStored('bc-input') ?? '');
  const [output, setOutput] = useState(() => readStored('bc-output') ?? '');
  const [camera, setCamera] = useState(() => readStored('bc-camera') ?? '');
  const request = useRef({ microphone: 0, camera: 0 });

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices) return;
    setDevices(await navigator.mediaDevices.enumerateDevices());
  }, []);

  useEffect(() => {
    void isWindowsDesktop().then(setWindowsDesktop);
  }, []);

  useEffect(() => {
    void refresh().catch(() => {});
    const changed = () => void refresh().catch(() => {});
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', changed);
  }, [refresh]);

  /** Devices of one kind, with a positional label when the real one is withheld. */
  const listing = (kind: MediaDeviceKind, fallback: string) =>
    devices
      .filter((device) => device.kind === kind && device.deviceId)
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `${fallback} ${index + 1}`,
      }));

  /** Persists the choice and tells live capture to pick it up. */
  const select =
    (key: 'bc-input' | 'bc-output' | 'bc-camera', setter: (value: string) => void, event: string) =>
    (value: string) => {
      setter(value);
      writeStored(key, value);
      window.dispatchEvent(new Event(event));
    };

  async function enable(kind: PermissionKind) {
    const setStatus = kind === 'camera' ? onCameraStatus : onMicrophoneStatus;
    const current = ++request.current[kind];
    const stale = () => !alive.current || current !== request.current[kind];
    setStatus('');
    try {
      await ensureDesktopPermission(kind);
      if (stale()) return;
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === 'camera' ? { video: true } : { audio: true },
      );
      stream.getTracks().forEach((track) => track.stop());
      if (stale()) return;
      await refresh();
      if (!stale())
        setStatus(
          `${kind === 'camera' ? 'Camera' : 'Microphone'} access enabled. Device names refreshed.`,
        );
    } catch (error) {
      if (!stale()) setStatus(deviceError(error, kind));
    }
  }

  const openPrivacySettings = async (kind: PermissionKind) => {
    try {
      await invoke('open_media_privacy_settings', { kind });
    } catch (error) {
      (kind === 'camera' ? onCameraStatus : onMicrophoneStatus)(deviceError(error));
    }
  };

  return {
    windowsDesktop,
    refresh,
    microphones: listing('audioinput', 'Microphone'),
    speakers: listing('audiooutput', 'Speaker'),
    cameras: listing('videoinput', 'Camera'),
    input,
    output,
    camera,
    selectInput: select('bc-input', setInput, 'bc-devices'),
    selectOutput: select('bc-output', setOutput, 'bc-output'),
    selectCamera: select('bc-camera', setCamera, 'bc-devices'),
    enable,
    openPrivacySettings,
  };
}
