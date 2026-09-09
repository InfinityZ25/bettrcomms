import { LinkButton } from '@/components/ui/link-button';
import {
  cameraFrameRates,
  cameraFrameRateSupported,
  cameraResolutions,
  cameraResolutionSupported,
  type CameraSettings,
} from '@/media/cameraSettings';
import {
  DeviceActions,
  DeviceCard,
  DeviceSelect,
  DeviceStatus,
  type DeviceOption,
} from './DeviceControls';
import { isDenied } from './deviceHelpers';
import type { useCameraPreview } from './useCameraPreview';

export default function CameraCard({
  options,
  value,
  onChange,
  status,
  preview,
  windowsDesktop,
  onEnable,
  onOpenPrivacy,
}: {
  options: DeviceOption[];
  value: string;
  onChange: (value: string) => void;
  status: string;
  preview: ReturnType<typeof useCameraPreview>;
  windowsDesktop: boolean;
  onEnable: () => void;
  onOpenPrivacy: () => void;
}) {
  const { quality, updateQuality, capabilities, actual, previewing } = preview;
  return (
    <DeviceCard>
      <DeviceSelect label="Camera" value={value} options={options} onChange={onChange} />
      <div className="camera-quality" aria-label="Camera quality">
        <label>
          Resolution
          <select
            value={quality.resolution}
            onChange={(event) =>
              updateQuality({
                ...quality,
                resolution: event.target.value as CameraSettings['resolution'],
              })
            }
          >
            {cameraResolutions.map((option) => {
              const unsupported = !cameraResolutionSupported(option.value, capabilities);
              return (
                <option key={option.value} value={option.value} disabled={unsupported}>
                  {option.label}
                  {unsupported ? ' · unavailable' : ''}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          Frame rate
          <select
            value={quality.frameRate}
            onChange={(event) =>
              updateQuality({
                ...quality,
                frameRate: Number(event.target.value) as CameraSettings['frameRate'],
              })
            }
          >
            {cameraFrameRates.map((rate) => {
              const unsupported = !cameraFrameRateSupported(rate, capabilities);
              return (
                <option key={rate} value={rate} disabled={unsupported}>
                  {rate} FPS{unsupported ? ' · unavailable' : ''}
                </option>
              );
            })}
          </select>
        </label>
      </div>
      {previewing && actual && (
        <p className="camera-quality__actual">
          Camera reports {actual.width ?? 'unknown'}×{actual.height ?? 'unknown'} at{' '}
          {actual.frameRate ? `${Math.round(actual.frameRate)} FPS` : 'an unknown frame rate'}.
        </p>
      )}
      <DeviceActions>
        <LinkButton onClick={onEnable}>Enable camera</LinkButton>
        <LinkButton onClick={() => void preview.toggle()}>
          {previewing ? 'Stop preview' : 'Preview camera'}
        </LinkButton>
        {windowsDesktop && isDenied(status) && (
          <LinkButton onClick={onOpenPrivacy}>Open privacy settings</LinkButton>
        )}
      </DeviceActions>
      <video
        ref={preview.video}
        className="device-settings__preview"
        muted
        playsInline
        hidden={!previewing}
      />
      <DeviceStatus status={status} error={isDenied(status)} />
    </DeviceCard>
  );
}
