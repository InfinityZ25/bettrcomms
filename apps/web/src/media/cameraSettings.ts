export type CameraResolution = 'auto' | '720p' | '1080p' | '1440p' | '4k';
export type CameraFrameRate = 15 | 30 | 60;

export interface CameraSettings {
  resolution: CameraResolution;
  frameRate: CameraFrameRate;
}

export const cameraResolutions: ReadonlyArray<{
  value: CameraResolution;
  label: string;
  width?: number;
  height?: number;
}> = [
  { value: 'auto', label: 'Auto' },
  { value: '720p', label: '720p', width: 1280, height: 720 },
  { value: '1080p', label: '1080p', width: 1920, height: 1080 },
  { value: '1440p', label: '1440p', width: 2560, height: 1440 },
  { value: '4k', label: '4K', width: 3840, height: 2160 },
];
export const cameraFrameRates: readonly CameraFrameRate[] = [15, 30, 60];

const defaultSettings: CameraSettings = {
  resolution: '1080p',
  frameRate: 30,
};

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

export function readCameraSettings(
  storage: StorageReader = localStorage,
): CameraSettings {
  const resolution = storage.getItem('bc-camera-resolution');
  const frameRate = Number(storage.getItem('bc-camera-fps'));
  return {
    resolution: cameraResolutions.some(({ value }) => value === resolution)
      ? (resolution as CameraResolution)
      : defaultSettings.resolution,
    frameRate: cameraFrameRates.includes(frameRate as CameraFrameRate)
      ? (frameRate as CameraFrameRate)
      : defaultSettings.frameRate,
  };
}

export function writeCameraSettings(
  settings: CameraSettings,
  storage: StorageWriter = localStorage,
): void {
  storage.setItem('bc-camera-resolution', settings.resolution);
  storage.setItem('bc-camera-fps', String(settings.frameRate));
}

export function cameraCaptureConstraints(
  deviceId: string,
  settings: CameraSettings = readCameraSettings(),
): MediaTrackConstraints {
  const resolution = cameraResolutions.find(
    ({ value }) => value === settings.resolution,
  );
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    ...(resolution?.width
      ? {
          width: { ideal: resolution.width },
          height: { ideal: resolution.height },
        }
      : {}),
    frameRate: { ideal: settings.frameRate },
  };
}

export function requestedCameraLabel(settings: CameraSettings): string {
  const resolution = cameraResolutions.find(
    ({ value }) => value === settings.resolution,
  )!;
  return `${resolution.label} at ${settings.frameRate} FPS`;
}

export function cameraResolutionSupported(
  resolution: CameraResolution,
  capabilities: MediaTrackCapabilities | null,
): boolean {
  const option = cameraResolutions.find(({ value }) => value === resolution)!;
  if (!option.width || !option.height || !capabilities) return true;
  const width = capabilities.width;
  const height = capabilities.height;
  return !(
    (width?.min !== undefined && option.width < width.min) ||
    (width?.max !== undefined && option.width > width.max) ||
    (height?.min !== undefined && option.height < height.min) ||
    (height?.max !== undefined && option.height > height.max)
  );
}

export function cameraFrameRateSupported(
  frameRate: CameraFrameRate,
  capabilities: MediaTrackCapabilities | null,
): boolean {
  const range = capabilities?.frameRate;
  return !(
    (range?.min !== undefined && frameRate < range.min) ||
    (range?.max !== undefined && frameRate > range.max)
  );
}
