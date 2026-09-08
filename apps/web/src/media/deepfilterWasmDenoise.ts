import type { DenoisedTrack } from './denoise';

const SAMPLE_RATE = 48_000;
const DEFAULT_ATTENUATION_DB = 40;

function assetBaseUrl(): string {
  return new URL('/deepfilter', window.location.href).href.replace(/\/$/, '');
}

/** Runs DeepFilterNet3 locally in a SIMD WebAssembly AudioWorklet. */
export async function createDeepfilterWasmDenoiser(
  rawTrack: MediaStreamTrack,
  attenuationDb = DEFAULT_ATTENUATION_DB,
): Promise<DenoisedTrack> {
  if (rawTrack.kind !== 'audio')
    throw new TypeError('DeepFilterNet3 requires an audio MediaStreamTrack');
  if (rawTrack.readyState === 'ended')
    throw new Error('Cannot denoise an ended audio track');
  if (
    typeof AudioContext === 'undefined' ||
    typeof AudioWorkletNode === 'undefined' ||
    typeof WebAssembly === 'undefined'
  )
    throw new Error(
      'DeepFilterNet3 is unavailable because AudioWorklet or WebAssembly is not supported',
    );

  const context = new AudioContext({
    latencyHint: 'interactive',
    sampleRate: SAMPLE_RATE,
  });
  const { DeepFilterNet3Core } = await import('deepfilternet3-noise-filter');
  const processor = new DeepFilterNet3Core({
    sampleRate: SAMPLE_RATE,
    noiseReductionLevel: Math.round(Math.max(0, Math.min(100, attenuationDb))),
    // Pin processing assets to the BetterComms origin instead of Mezon's CDN.
    assetConfig: { cdnUrl: assetBaseUrl() },
  });
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let outputTrack: MediaStreamTrack | undefined;
  let disposed = false;
  let reportFailure: ((error: unknown) => void) | undefined;
  const failure = new Promise<unknown>((resolve) => {
    reportFailure = resolve;
  });
  const onProcessorError = (event: Event) => {
    reportFailure?.(
      event instanceof ErrorEvent
        ? (event.error ?? new Error(event.message))
        : new Error('DeepFilterNet3 audio processor stopped'),
    );
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    outputTrack?.stop();
    source?.disconnect();
    worklet?.removeEventListener('processorerror', onProcessorError);
    worklet?.disconnect();
    destination?.disconnect();
    processor.destroy();
    void context.close().catch(() => undefined);
  };

  try {
    await processor.initialize();
    worklet = await processor.createAudioWorkletNode(context);
    worklet.addEventListener('processorerror', onProcessorError, {
      once: true,
    });
    worklet.channelCount = 1;
    worklet.channelCountMode = 'explicit';
    worklet.channelInterpretation = 'speakers';
    source = context.createMediaStreamSource(new MediaStream([rawTrack]));
    destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    source.connect(worklet).connect(destination);
    outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack)
      throw new Error('DeepFilterNet3 did not produce an audio track');
    await context.resume();
    return { track: outputTrack, failure, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
