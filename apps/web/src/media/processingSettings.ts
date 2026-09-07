import { isTauri } from '@tauri-apps/api/core';
import type { CaptureOptions, MicrophoneProcessingSettings } from './types';
export type { MicrophoneProcessingSettings } from './types';

const defaults: MicrophoneProcessingSettings = {
  engine: 'rnnoise',
  echoCancellation: true,
  autoGainControl: false,
  nvidiaIntensity: 1,
  nvidiaVad: false,
  deepfilterAttenuationDb: 100,
  highPassHz: 0,
  gainDb: 0,
  gateEnabled: false,
  gateThresholdDb: -45,
  gateAttackMs: 5,
  gateHoldMs: 150,
  gateReleaseMs: 120,
};

const clamp = (value: unknown, fallback: number, low: number, high: number) => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number)
    ? Math.min(high, Math.max(low, number))
    : fallback;
};

function normalizedTuning(
  value: unknown,
): Omit<MicrophoneProcessingSettings, 'engine'> {
  const input =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  return {
    echoCancellation:
      typeof input.echoCancellation === 'boolean'
        ? input.echoCancellation
        : defaults.echoCancellation,
    autoGainControl:
      typeof input.autoGainControl === 'boolean'
        ? input.autoGainControl
        : defaults.autoGainControl,
    nvidiaIntensity: clamp(
      input.nvidiaIntensity,
      defaults.nvidiaIntensity,
      0,
      1,
    ),
    nvidiaVad:
      typeof input.nvidiaVad === 'boolean'
        ? input.nvidiaVad
        : defaults.nvidiaVad,
    deepfilterAttenuationDb: clamp(
      input.deepfilterAttenuationDb,
      defaults.deepfilterAttenuationDb,
      0,
      100,
    ),
    highPassHz: clamp(input.highPassHz, defaults.highPassHz, 0, 2_000),
    gainDb: clamp(input.gainDb, defaults.gainDb, -24, 24),
    ...(typeof input.inputVolume === 'number'
      ? { inputVolume: clamp(input.inputVolume, 1, 0, 2) }
      : {}),
    gateEnabled:
      typeof input.gateEnabled === 'boolean'
        ? input.gateEnabled
        : defaults.gateEnabled,
    gateThresholdDb: clamp(
      input.gateThresholdDb,
      defaults.gateThresholdDb,
      -96,
      0,
    ),
    gateAttackMs: clamp(input.gateAttackMs, defaults.gateAttackMs, 0, 1_000),
    gateHoldMs: clamp(input.gateHoldMs, defaults.gateHoldMs, 0, 5_000),
    gateReleaseMs: clamp(input.gateReleaseMs, defaults.gateReleaseMs, 0, 5_000),
  };
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readProcessingSettings(): MicrophoneProcessingSettings {
  const store = storage();
  let tuning: unknown;
  try {
    tuning = JSON.parse(store?.getItem('bc-processing') ?? '{}');
  } catch {
    tuning = {};
  }
  const selected = store?.getItem('bc-denoiser');
  let engine: MicrophoneProcessingSettings['engine'];
  if (store?.getItem('bc-noise') === 'off') engine = 'off';
  else if (
    selected === 'rnnoise' ||
    selected === 'speex' ||
    selected === 'deepfilter-wasm' ||
    selected === 'off' ||
    selected === 'standard'
  )
    engine = selected;
  else if (selected === 'nvidia' || selected === 'deepfilter')
    engine = isTauri() ? selected : 'standard';
  else engine = 'rnnoise';
  return { engine, ...normalizedTuning(tuning) };
}

export function saveProcessingSettings(
  partial: Partial<MicrophoneProcessingSettings>,
): MicrophoneProcessingSettings {
  const current = readProcessingSettings();
  const next = { ...current, ...normalizedTuning({ ...current, ...partial }) };
  const { engine: _engine, ...tuning } = next;
  storage()?.setItem('bc-processing', JSON.stringify(tuning));
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event('bc-processing'));
  return next;
}

export function microphoneCaptureOptions(deviceId?: string): CaptureOptions {
  const processing = readProcessingSettings();
  return {
    camera: false,
    microphone: deviceId ? { deviceId: { exact: deviceId } } : true,
    denoiser: processing.engine,
    noiseSuppression: processing.engine === 'standard',
    echoCancellation: processing.echoCancellation,
    autoGainControl: processing.autoGainControl,
    processing,
  };
}
