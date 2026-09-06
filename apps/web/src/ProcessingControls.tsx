import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from './components/ui/button';
import {
  readProcessingSettings,
  saveProcessingSettings,
  type MicrophoneProcessingSettings,
} from './media/processingSettings';
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
      | 'gainDb'
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
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft[key]}
        onChange={(e) => update({ [key]: Number(e.target.value) })}
      />
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
        <p>
          RNNoise automatically identifies noise and has no built-in strength
          setting. The optional gate below silences quiet sounds after RNNoise;
          it does not change the model.
        </p>
      )}
      {engine === 'speex' && (
        <p>
          SpeexDSP provides lightweight noise suppression. Its Web Audio
          processor does not expose a suppression-strength setting; the optional
          filters below run after Speex.
        </p>
      )}
      {engine === 'standard' && (
        <p>
          Your browser handles noise suppression. It exposes echo cancellation
          and automatic gain, but no suppression-strength slider.
        </p>
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
          <label className="switch-row">
            <div>
              <strong>Speech-only filtering (VAD)</strong>
              <p>
                Removes non-speech sounds. It can also remove music and quiet
                speech.
              </p>
            </div>
            <input
              type="checkbox"
              checked={draft.nvidiaVad}
              onChange={(e) => update({ nvidiaVad: e.target.checked })}
            />
          </label>
        </div>
      )}
      {engine === 'deepfilter' && (
        <div className="processing-engine">
          {slider(
            'deepfilterAttenuationDb',
            'Maximum noise attenuation',
            0,
            100,
            1,
            ' dB',
          )}
          <p>
            Limits the most noise DeepFilterNet may remove. 100 dB applies the
            model's maximum suppression.
          </p>
        </div>
      )}
      <div className="processing-options">
        <label className="switch-row">
          <div>
            <strong>Echo cancellation</strong>
            <p>Reduce speaker audio picked up by your microphone.</p>
          </div>
          <input
            type="checkbox"
            checked={draft.echoCancellation}
            onChange={(e) => update({ echoCancellation: e.target.checked })}
          />
        </label>
        <label className="switch-row">
          <div>
            <strong>Automatic microphone gain</strong>
            <p>Let the capture backend adjust input loudness.</p>
          </div>
          <input
            type="checkbox"
            checked={draft.autoGainControl}
            onChange={(e) => update({ autoGainControl: e.target.checked })}
          />
        </label>
      </div>
      <div className="processing-options">
        <label>
          Low-cut filter
          <select
            value={draft.highPassHz}
            onChange={(e) => update({ highPassHz: Number(e.target.value) })}
          >
            <option value={0}>Off · preserve full range</option>
            {[60, 80, 100, 120, 160].map((hz) => (
              <option value={hz} key={hz}>
                {hz} Hz · reduce low rumble
              </option>
            ))}
          </select>
        </label>
        {slider('gainDb', 'Microphone gain', -12, 12, 1, ' dB')}
      </div>
      <label className="switch-row">
        <div>
          <strong>Quiet-sound gate</strong>
          <p>
            Silence remaining noise between phrases. High thresholds can cut off
            soft speech.
          </p>
        </div>
        <input
          type="checkbox"
          checked={draft.gateEnabled}
          onChange={(e) => update({ gateEnabled: e.target.checked })}
        />
      </label>
      {draft.gateEnabled && (
        <div className="processing-options">
          {slider('gateThresholdDb', 'Gate threshold', -60, -20, 1, ' dB')}
          {slider('gateAttackMs', 'Gate attack', 1, 50, 1, ' ms')}
          {slider('gateHoldMs', 'Gate hold', 0, 500, 10, ' ms')}
          {slider('gateReleaseMs', 'Gate release', 20, 500, 10, ' ms')}
        </div>
      )}
      <div className="processing-apply">
        <Button
          variant="secondary"
          onClick={() => {
            const { engine: _engine, ...tuning } = draft;
            setDraft(saveProcessingSettings(tuning));
            setStatus('Applied to calls and microphone tests.');
          }}
        >
          Apply microphone settings
        </Button>
        <span role="status">{status}</span>
      </div>
      <p>
        These filters affect your outgoing microphone and its test sample. Apply
        changes, then run a new microphone test to hear them.
      </p>
    </section>
  );
}
