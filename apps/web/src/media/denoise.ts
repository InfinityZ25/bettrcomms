import {
  loadRnnoise,
  RnnoiseWorkletNode,
} from '@sapphi-red/web-noise-suppressor';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseWasmSimdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';

export interface DenoisedTrack {
  track: MediaStreamTrack;
  /** Resolves with the cause if a running processor becomes unavailable. */
  failure?: Promise<unknown>;
  dispose(): void;
}

/**
 * Creates a private RNNoise AudioWorklet graph for one caller-owned audio track.
 *
 * The graph terminates at a MediaStreamAudioDestinationNode and is never connected
 * to the speakers. `dispose` stops only the generated track; the caller owns and
 * must stop `rawTrack` when capture itself should end.
 */
export async function createDenoiser(
  rawTrack: MediaStreamTrack,
): Promise<DenoisedTrack> {
  if (rawTrack.kind !== 'audio') {
    throw new TypeError('RNNoise requires an audio MediaStreamTrack');
  }
  if (rawTrack.readyState === 'ended') {
    throw new Error('Cannot denoise an ended audio track');
  }
  if (
    typeof AudioContext === 'undefined' ||
    typeof AudioWorkletNode === 'undefined'
  ) {
    throw new Error(
      'RNNoise is unavailable because AudioWorklet is not supported',
    );
  }

  const context = new AudioContext({
    latencyHint: 'interactive',
    sampleRate: 48_000,
  });
  let source: MediaStreamAudioSourceNode | undefined;
  let denoiser: RnnoiseWorkletNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let outputTrack: MediaStreamTrack | undefined;
  let disposed = false;

  const cleanup = () => {
    if (disposed) return;
    disposed = true;

    outputTrack?.stop();
    source?.disconnect();
    denoiser?.disconnect();
    denoiser?.destroy();
    destination?.disconnect();
    void context.close().catch(() => undefined);
  };

  try {
    const [wasmBinary] = await Promise.all([
      loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseWasmSimdUrl }),
      context.audioWorklet.addModule(rnnoiseWorkletUrl),
    ]);

    source = context.createMediaStreamSource(new MediaStream([rawTrack]));
    denoiser = new RnnoiseWorkletNode(context, {
      wasmBinary,
      maxChannels: 1,
    });
    // maxChannels limits DSP state, not Web Audio's negotiated channel layout.
    // Mix both interface inputs before DSP rather than emitting left + silence.
    denoiser.channelCount = 1;
    denoiser.channelCountMode = 'explicit';
    denoiser.channelInterpretation = 'speakers';
    destination = context.createMediaStreamDestination();
    destination.channelCount = 1;

    source.connect(denoiser);
    denoiser.connect(destination);

    outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack) {
      throw new Error('RNNoise did not produce an audio track');
    }

    await context.resume();
    return { track: outputTrack, dispose: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
