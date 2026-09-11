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
import { SettingsSelect } from '../SettingsControls';

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
          <SettingsSelect
            ariaLabel="Resolution"
            value={quality.resolution}
            onValueChange={(value) =>
              updateQuality({
                ...quality,
                resolution: value as CameraSettings['resolution'],
              })
            }
            options={cameraResolutions.map((option) => {
              const unsupported = !cameraResolutionSupported(option.value, capabilities);
              return { value: option.value, label: option.label, disabled: unsupported };
            })}
          />
        </label>
        <label>
          Frame rate
          <SettingsSelect
            ariaLabel="Frame rate"
            value={quality.frameRate}
            onValueChange={(value) =>
              updateQuality({
                ...quality,
                frameRate: Number(value) as CameraSettings['frameRate'],
              })
            }
            options={cameraFrameRates.map((rate) => {
              const unsupported = !cameraFrameRateSupported(rate, capabilities);
              return { value: rate, label: `${rate} FPS`, disabled: unsupported };
            })}
          />
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
