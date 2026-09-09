import { useState } from 'react';
import { readStoredFlag, writeStored } from '@/lib/storage';
import type { NativeScreenSource, NativeScreenStartOptions } from '@/media/nativeScreen';
import type { NativeSystemAudioCapabilities } from '@/media/nativeSystemAudio';

export type FpsChoice = '30' | '60' | '120' | 'custom';
export type BitrateChoice = '8' | '10' | '12' | '16' | '20' | '40' | '80' | 'custom';
export type ContentChoice = 'auto' | 'motion' | 'detail';
export type AudioScope = 'application' | 'system';

export const bitratePresets = [8, 10, 12, 16, 20, 40, 80] as const;

const FPS_RANGE = [15, 240] as const;
const BITRATE_RANGE = [1, 200] as const;

const DIMENSIONS: Record<string, [number, number]> = {
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4k': [3840, 2160],
};

/** 1080p60 is the throughput a compatibility viewer is expected to keep up with. */
const COMPATIBILITY_PIXEL_RATE = 1920 * 1080 * 60;

/**
 * Quality, cursor and audio choices for a native capture, and the option object
 * they add up to. Nothing here touches the capture itself.
 */
export function useShareOptions({
  selected,
  tab,
  audioCaps,
}: {
  selected?: NativeScreenSource;
  tab: 'window' | 'monitor';
  audioCaps: NativeSystemAudioCapabilities | null;
}) {
  const [resolution, setResolution] = useState('source');
  const [contentChoice, setContentChoice] = useState<ContentChoice>('auto');
  const [fpsChoice, setFpsChoice] = useState<FpsChoice>('60');
  const [customFps, setCustomFps] = useState('144');
  const [bitrateChoice, setBitrateChoice] = useState<BitrateChoice>('20');
  const [customBitrate, setCustomBitrate] = useState('20');
  const [h264Profile, setH264Profile] = useState<'auto' | 'baseline'>('auto');
  const [cursor, setCursor] = useState(true);
  const [displayBorder, setDisplayBorderState] = useState(() =>
    readStoredFlag('bc-capture-border', 'true', false),
  );
  const [systemAudio, setSystemAudio] = useState(true);
  const [excludeCallAudio, setExcludeCallAudio] = useState(true);
  const [audioScope, setAudioScope] = useState<AudioScope>('application');

  const setDisplayBorder = (value: boolean) => {
    setDisplayBorderState(value);
    writeStored('bc-capture-border', String(value));
  };

  const fps = Number(fpsChoice === 'custom' ? customFps : fpsChoice);
  const bitrateMbps = Number(bitrateChoice === 'custom' ? customBitrate : bitrateChoice);
  const whole = (value: number, [low, high]: readonly [number, number]) =>
    Number.isInteger(value) && value >= low && value <= high;
  const qualityValid = whole(fps, FPS_RANGE) && whole(bitrateMbps, BITRATE_RANGE);

  // Only a window can have its own audio captured; a monitor is always system-wide.
  const applicationAudio =
    (selected?.kind ?? tab) === 'window' && audioScope === 'application';
  const audioAvailable =
    audioCaps?.available === true &&
    (!applicationAudio || audioCaps.applicationAudio === true);

  const resolutionLabel =
    resolution === 'source'
      ? selected
        ? `Match source (${selected.width}×${selected.height})`
        : 'Match source'
      : resolution.toUpperCase();
  const requestedPixels =
    resolution === 'source'
      ? selected
        ? selected.width * selected.height
        : 0
      : DIMENSIONS[resolution][0] * DIMENSIONS[resolution][1];
  const exceedsCompatibility = requestedPixels * fps > COMPATIBILITY_PIXEL_RATE;

  /** The native options for the current selection; call only when `qualityValid`. */
  const buildOptions = (
    sourceId: string,
    encoder: NativeScreenStartOptions['encoder'],
  ): NativeScreenStartOptions => {
    const [width, height] = DIMENSIONS[resolution] ?? [0, 0];
    const shareAudio = systemAudio && audioAvailable;
    return {
      sourceId,
      encoder,
      width,
      height,
      fps,
      bitrateMbps,
      contentHint:
        contentChoice === 'auto'
          ? selected?.category === 'game'
            ? 'motion'
            : 'detail'
          : contentChoice,
      h264Profile,
      cursor,
      displayBorder,
      systemAudio: shareAudio,
      ...(shareAudio && applicationAudio ? { systemAudioSourceId: sourceId } : {}),
      excludeCallAudio: applicationAudio || excludeCallAudio,
    };
  };

  return {
    resolution,
    setResolution,
    resolutionLabel,
    contentChoice,
    setContentChoice,
    fpsChoice,
    setFpsChoice,
    customFps,
    setCustomFps,
    fps,
    bitrateChoice,
    setBitrateChoice,
    customBitrate,
    setCustomBitrate,
    bitrateMbps,
    h264Profile,
    setH264Profile,
    cursor,
    setCursor,
    displayBorder,
    setDisplayBorder,
    systemAudio,
    setSystemAudio,
    excludeCallAudio,
    setExcludeCallAudio,
    audioScope,
    setAudioScope,
    applicationAudio,
    audioAvailable,
    qualityValid,
    exceedsCompatibility,
    buildOptions,
  };
}
