import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SettingsSelect, SettingsSlider } from './SettingsControls';
import {
  readProcessingSettings,
  saveProcessingSettings,
  type MicrophoneProcessingSettings,
} from '@/media/processingSettings';
import './ProcessingControls.css';

export default function ProcessingControls({ engine }: { engine: string }) {
  const [draft, setDraft] = useState(readProcessingSettings);
  const [status, setStatus] = useState('');
  const update = (patch: Partial<MicrophoneProcessingSettings>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setStatus('Unapplied changes');
  };
  const slider = (
    key:
      | 'nvidiaIntensity'
      | 'deepfilterAttenuationDb'
      | 'gateThresholdDb'
      | 'gateAttackMs'
      | 'gateHoldMs'
      | 'gateReleaseMs',
    label: string,
    min: number,
    max: number,
    step: number,
    unit: string,
  ) => (
    <label className="processing-range" key={key}>
      <span>
        {label}
        <output>
          {key === 'nvidiaIntensity'
            ? Math.round(draft[key] * 100)
            : draft[key]}
          {unit}
        </output>
      </span>
      <SettingsSlider ariaLabel={label} value={draft[key]} min={min} max={max} step={step} onValueChange={(value) => update({ [key]: value })} />
    </label>
  );
  return (
    <section
      className="processing-controls"
      aria-label="Microphone processing settings"
    >
      <h3>
        <SlidersHorizontal size={17} /> Fine-tune your microphone
      </h3>
      {engine === 'rnnoise' && (
        <p>Enhanced noise removal adjusts itself automatically.</p>
      )}
      {engine === 'speex' && (
        <p>A lighter option for older devices.</p>
      )}
      {engine === 'standard' && (
        <p>Uses your system's built-in microphone cleanup.</p>
      )}
      {engine === 'nvidia' && (
        <div className="processing-engine">
          {slider(
            'nvidiaIntensity',
            'NVIDIA suppression strength',
            0,
            1,
            0.05,
            '%',
          )}
          <div className="switch-row">
            <div>
              <strong>Speech-only filtering (VAD)</strong>
              <p>
                Removes non-speech sounds. It can also remove music and quiet
                speech.
              </p>
            </div>
            <Switch
              aria-label="Speech-only filtering (VAD)"
              checked={draft.nvidiaVad}
              onCheckedChange={(nvidiaVad) => update({ nvidiaVad })}
            />
          </div>
        </div>
      )}
      {(engine === 'deepfilter' || engine === 'deepfilter-wasm') && (
        <div className="processing-engine">
          {slider(
            'deepfilterAttenuationDb',
            'Maximum noise attenuation',
            0,
            100,
            1,
            ' dB',
          )}
          <p>Sets how much background sound can be removed.</p>
        </div>
      )}
      <details className="processing-advanced">
        <summary>Advanced audio controls</summary>
      <div className="processing-options">
        <div className="switch-row">
          <div>
            <strong>Echo cancellation</strong>
            <p>Reduce speaker audio picked up by your microphone.</p>
          </div>
          <Switch
            aria-label="Echo cancellation"
            checked={draft.echoCancellation}
            onCheckedChange={(echoCancellation) => update({ echoCancellation })}
          />
        </div>
        <div className="switch-row">
          <div>
            <strong>Automatic microphone gain</strong>
            <p>Let the capture backend automatically level changing speech. This is separate from Input volume.</p>
          </div>
          <Switch
            aria-label="Automatic microphone gain"
            checked={draft.autoGainControl}
            onCheckedChange={(autoGainControl) => update({ autoGainControl })}
          />
        </div>
      </div>
      <div className="processing-options">
        <label>
          Low-cut filter
          <SettingsSelect
            ariaLabel="Low-cut filter"
            value={draft.highPassHz}
            onValueChange={(value) => update({ highPassHz: Number(value) })}
            options={[{ value: 0, label: 'Off' }, ...[60, 80, 100, 120, 160].map((hz) => ({ value: hz, label: `${hz} Hz` }))]}
          />
        </label>
      </div>
      <div className="switch-row">
        <div>
          <strong>Quiet-sound gate</strong>
          <p>
            Silence remaining noise between phrases. High thresholds can cut off
            soft speech.
          </p>
        </div>
        <Switch
          aria-label="Quiet-sound gate"
          checked={draft.gateEnabled}
          onCheckedChange={(gateEnabled) => update({ gateEnabled })}
        />
      </div>
      {draft.gateEnabled && (
        <div className="processing-options">
          {slider('gateThresholdDb', 'Gate threshold', -60, -20, 1, ' dB')}
          {slider('gateAttackMs', 'Gate attack', 1, 50, 1, ' ms')}
          {slider('gateHoldMs', 'Gate hold', 0, 500, 10, ' ms')}
          {slider('gateReleaseMs', 'Gate release', 20, 500, 10, ' ms')}
        </div>
      )}
      </details>
      <div className="processing-apply">
        <Button
          variant="secondary"
          onClick={() => {
            const {
              engine: _engine,
              gainDb: _gainDb,
              inputVolume: _inputVolume,
              ...tuning
            } = draft;
            setDraft(saveProcessingSettings(tuning));
            setStatus('Applied to calls and microphone tests.');
          }}
        >
          Apply microphone settings
        </Button>
        <span role="status">{status}</span>
      </div>
      <p>
        Apply changes, then run a microphone test to hear the result.
      </p>
    </section>
  );
}
