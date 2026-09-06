import { describe, expect, it } from 'vitest';
import {
  cameraCaptureConstraints,
  cameraFrameRateSupported,
  cameraResolutionSupported,
  readCameraSettings,
  requestedCameraLabel,
  writeCameraSettings,
} from './cameraSettings';

function memoryStorage(values: Record<string, string> = {}) {
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
    values,
  };
}

describe('camera settings', () => {
  it('defaults to 1080p at 30 FPS and builds ideal fallback constraints', () => {
    const settings = readCameraSettings(memoryStorage());
    expect(settings).toEqual({ resolution: '1080p', frameRate: 30 });
    expect(cameraCaptureConstraints('camera-id', settings)).toEqual({
      deviceId: { exact: 'camera-id' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    });
    expect(requestedCameraLabel(settings)).toBe('1080p at 30 FPS');
  });

  it('persists supported values and leaves resolution to the camera in Auto', () => {
    const storage = memoryStorage();
    writeCameraSettings({ resolution: 'auto', frameRate: 60 }, storage);
    const settings = readCameraSettings(storage);
    expect(settings).toEqual({ resolution: 'auto', frameRate: 60 });
    expect(cameraCaptureConstraints('', settings)).toEqual({
      frameRate: { ideal: 60 },
    });
  });

  it('rejects stale or edited storage values by returning safe defaults', () => {
    expect(
      readCameraSettings(
        memoryStorage({
          'bc-camera-resolution': '8k',
          'bc-camera-fps': '240',
        }),
      ),
    ).toEqual({ resolution: '1080p', frameRate: 30 });
  });

  it('reports only modes inside capabilities learned from an explicit preview', () => {
    const capabilities = {
      width: { min: 640, max: 1920 },
      height: { min: 480, max: 1080 },
      frameRate: { min: 15, max: 30 },
    } as MediaTrackCapabilities;
    expect(cameraResolutionSupported('auto', capabilities)).toBe(true);
    expect(cameraResolutionSupported('1080p', capabilities)).toBe(true);
    expect(cameraResolutionSupported('1440p', capabilities)).toBe(false);
    expect(cameraFrameRateSupported(30, capabilities)).toBe(true);
    expect(cameraFrameRateSupported(60, capabilities)).toBe(false);
    expect(cameraResolutionSupported('4k', null)).toBe(true);
  });
});
