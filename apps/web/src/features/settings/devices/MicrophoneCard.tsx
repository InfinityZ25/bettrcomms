import { LinkButton } from '@/components/ui/link-button';
import { readInputVolume, setInputVolume } from '@/media/volumeSettings';
import { useState } from 'react';
import {
  DeviceActions,
  DeviceCard,
  DeviceSelect,
  DeviceStatus,
  LevelMeter,
  VolumeSlider,
  type DeviceOption,
} from './DeviceControls';
import { isDenied } from './deviceHelpers';
import type { useMicrophoneTest } from './useMicrophoneTest';
import { SettingsSlider } from '../SettingsControls';

export default function MicrophoneCard({
  options,
  value,
  onChange,
  status,
  test,
  windowsDesktop,
  onEnable,
  onOpenPrivacy,
  onStatus,
}: {
  options: DeviceOption[];
  value: string;
  onChange: (value: string) => void;
  status: string;
  test: ReturnType<typeof useMicrophoneTest>;
  windowsDesktop: boolean;
  onEnable: () => void;
  onOpenPrivacy: () => void;
  onStatus: (status: string) => void;
}) {
  const [volume, setVolume] = useState(readInputVolume);
  return (
    <DeviceCard>
      <DeviceSelect
        label="Microphone"
        value={value}
        options={options}
        onChange={onChange}
      />
      <VolumeSlider
        label="Input volume"
        value={volume}
        onChange={(next) => {
          setVolume(next);
          setInputVolume(next);
        }}
      />
      <DeviceActions>
        <LinkButton onClick={onEnable}>Enable microphone</LinkButton>
        <LinkButton disabled={test.recording} onClick={() => void test.start()}>
          {test.recording ? 'Recording…' : 'Test microphone'}
        </LinkButton>
        <LinkButton
          aria-pressed={test.monitoring}
          onClick={() => {
            if (!test.monitoring) return void test.start('live');
            test.stop();
            onStatus('Live loopback stopped.');
          }}
        >
          {test.monitoring ? 'Stop live loopback' : 'Start live loopback'}
        </LinkButton>
        {windowsDesktop && isDenied(status) && (
          <LinkButton onClick={onOpenPrivacy}>Open privacy settings</LinkButton>
        )}
      </DeviceActions>
      {test.monitoring && (
        <label className="loopback-volume">
          Monitor volume · {Math.round(test.monitorVolume * 100)}%
          <SettingsSlider ariaLabel="Monitor volume" value={test.monitorVolume} min={0} max={1} step={0.05} onValueChange={test.setMonitorLevel} />
          <span>
            Use headphones to avoid echo. Nothing from this test is saved.
          </span>
        </label>
      )}
      <LevelMeter level={test.level} />
      {test.levels && (
        <div className="device-settings__status">
          <p>
            Last measured: input {test.levels.input.toFixed(1)} dBFS · processed{' '}
            {test.levels.processed.toFixed(1)} dBFS
          </p>
          <p>
            Loudest level: input {test.levels.inputPeak.toFixed(1)} dBFS · processed{' '}
            {test.levels.processedPeak.toFixed(1)} dBFS
          </p>
          <LinkButton onClick={test.copyDiagnostics}>
            Copy microphone diagnostics
          </LinkButton>
          {test.diagnosticStatus && <p role="status">{test.diagnosticStatus}</p>}
        </div>
      )}
      <DeviceStatus status={status} error={isDenied(status)} />
    </DeviceCard>
  );
}
