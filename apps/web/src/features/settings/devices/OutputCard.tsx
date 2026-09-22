import { useState } from 'react';
import { LinkButton } from '@/components/ui/link-button';
import { readOutputVolume, setOutputVolume } from '@/media/volumeSettings';
import {
  DeviceActions,
  DeviceCard,
  DeviceSelect,
  DeviceStatus,
  VolumeSlider,
  type DeviceOption,
} from './DeviceControls';

export default function OutputCard({
  options,
  value,
  onChange,
  status,
  onTest,
}: {
  options: DeviceOption[];
  value: string;
  onChange: (value: string) => void;
  status: string;
  onTest: () => void;
}) {
  const [volume, setVolume] = useState(readOutputVolume);
  return (
    <DeviceCard>
      <DeviceSelect
        label="Output device"
        value={value}
        options={options}
        onChange={onChange}
      />
      <VolumeSlider
        label="Output volume"
        value={volume}
        onChange={(next) => {
          setVolume(next);
          setOutputVolume(next);
        }}
      />
      <DeviceActions>
        <LinkButton onClick={onTest}>Play test tone</LinkButton>
      </DeviceActions>
      <DeviceStatus status={status} error={/cannot|failed|error/i.test(status)} />
    </DeviceCard>
  );
}
