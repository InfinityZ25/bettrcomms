import type { DenoisedTrack } from './denoise';
import type { MicrophoneProcessingSettings } from './types';
import effectsWorkletUrl from './microphoneEffects.worklet.js?url&no-inline';
import { readInputVolume } from './volumeSettings';

export async function createMicrophoneEffects(
  inputTrack: MediaStreamTrack,
  settings: MicrophoneProcessingSettings,
): Promise<DenoisedTrack> {
  const needsEffects =
    settings.highPassHz !== 0 || settings.gateEnabled;
  // Some USB interfaces ignore a mono capture preference and return two inputs.
  // Keep speech centered even with suppression/effects disabled.
  if (inputTrack.kind !== 'audio' || inputTrack.readyState === 'ended')
    throw new Error('Microphone effects require a live audio track');
  const context = new AudioContext({ latencyHint: 'interactive' });
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | GainNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let outputTrack: MediaStreamTrack | undefined;
  let volume: GainNode | undefined;
  const updateVolume = () => volume?.gain.setTargetAtTime(readInputVolume(), context.currentTime, 0.02);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('bc-input-volume', updateVolume);
    outputTrack?.stop();
    source?.disconnect();
    node?.disconnect();
    volume?.disconnect();
    destination?.disconnect();
    void context.close().catch(() => undefined);
  };
  try {
    if (needsEffects) await context.audioWorklet.addModule(effectsWorkletUrl);
    source = context.createMediaStreamSource(new MediaStream([inputTrack]));
    node = needsEffects
      ? new AudioWorkletNode(context, 'bettercomms-microphone-effects', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { ...settings, gainDb: 0 },
        })
      : new GainNode(context, {
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        });
    destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    source.connect(node);
    volume = context.createGain();
    volume.gain.value = Math.max(0, Math.min(2, settings.inputVolume ?? 10 ** (settings.gainDb / 20)));
    node.connect(volume).connect(destination);
    window.addEventListener('bc-input-volume', updateVolume);
    outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack)
      throw new Error('Microphone effects did not produce an audio track');
    await context.resume();
    return { track: outputTrack, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
