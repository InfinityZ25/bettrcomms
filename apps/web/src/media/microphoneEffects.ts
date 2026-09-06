import type { DenoisedTrack } from './denoise';
import type { MicrophoneProcessingSettings } from './types';
import effectsWorkletUrl from './microphoneEffects.worklet.js?url&no-inline';

export async function createMicrophoneEffects(
  inputTrack: MediaStreamTrack,
  settings: MicrophoneProcessingSettings,
): Promise<DenoisedTrack> {
  if (
    settings.highPassHz === 0 &&
    settings.gainDb === 0 &&
    !settings.gateEnabled
  )
    return { track: inputTrack, dispose() {} };
  if (inputTrack.kind !== 'audio' || inputTrack.readyState === 'ended')
    throw new Error('Microphone effects require a live audio track');
  const context = new AudioContext({ latencyHint: 'interactive' });
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let outputTrack: MediaStreamTrack | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    outputTrack?.stop();
    source?.disconnect();
    node?.disconnect();
    destination?.disconnect();
    void context.close().catch(() => undefined);
  };
  try {
    await context.audioWorklet.addModule(effectsWorkletUrl);
    source = context.createMediaStreamSource(new MediaStream([inputTrack]));
    node = new AudioWorkletNode(context, 'bettercomms-microphone-effects', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: settings,
    });
    destination = context.createMediaStreamDestination();
    source.connect(node);
    node.connect(destination);
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
