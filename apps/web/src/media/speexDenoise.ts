import { loadSpeex, SpeexWorkletNode } from '@sapphi-red/web-noise-suppressor';
import speexWasmUrl from '@sapphi-red/web-noise-suppressor/speex.wasm?url';
import speexWorkletUrl from '@sapphi-red/web-noise-suppressor/speexWorklet.js?url';
import type { DenoisedTrack } from './denoise';

/** Creates a private SpeexDSP preprocessing graph for one caller-owned track. */
export async function createSpeexDenoiser(
  rawTrack: MediaStreamTrack,
): Promise<DenoisedTrack> {
  if (rawTrack.kind !== 'audio') {
    throw new TypeError('Speex requires an audio MediaStreamTrack');
  }
  if (rawTrack.readyState === 'ended') {
    throw new Error('Cannot denoise an ended audio track');
  }
  if (
    typeof AudioContext === 'undefined' ||
    typeof AudioWorkletNode === 'undefined'
  ) {
    throw new Error(
      'Speex is unavailable because AudioWorklet is not supported',
    );
  }

  const context = new AudioContext({
    latencyHint: 'interactive',
    sampleRate: 48_000,
  });
  let source: MediaStreamAudioSourceNode | undefined;
  let denoiser: SpeexWorkletNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let outputTrack: MediaStreamTrack | undefined;
  let disposed = false;
  const inputEnded = () => rawTrack.readyState === 'ended';
  const isDisposed = () => disposed;
  let resolveFailure: (reason: unknown) => void = () => undefined;
  const failure = new Promise<unknown>((resolve) => {
    resolveFailure = resolve;
  });

  const handleRawEnded = () =>
    cleanup(new Error('Speex input track ended unexpectedly'));
  const handleProcessorError = () =>
    cleanup(new Error('Speex AudioWorklet processor failed'));

  const cleanup = (failureReason?: unknown) => {
    if (disposed) return;
    disposed = true;
    rawTrack.removeEventListener('ended', handleRawEnded);
    denoiser?.removeEventListener('processorerror', handleProcessorError);
    outputTrack?.stop();
    source?.disconnect();
    denoiser?.disconnect();
    denoiser?.destroy();
    destination?.disconnect();
    void context.close().catch(() => undefined);
    if (failureReason !== undefined) resolveFailure(failureReason);
  };

  try {
    const [wasmBinary] = await Promise.all([
      loadSpeex({ url: speexWasmUrl }),
      context.audioWorklet.addModule(speexWorkletUrl),
    ]);
    if (inputEnded()) {
      throw new Error('Cannot denoise an ended audio track');
    }
    source = context.createMediaStreamSource(new MediaStream([rawTrack]));
    denoiser = new SpeexWorkletNode(context, { wasmBinary, maxChannels: 1 });
    rawTrack.addEventListener('ended', handleRawEnded, { once: true });
    denoiser.addEventListener('processorerror', handleProcessorError, {
      once: true,
    });
    destination = context.createMediaStreamDestination();
    source.connect(denoiser);
    denoiser.connect(destination);
    outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack) throw new Error('Speex did not produce an audio track');
    await context.resume();
    if (isDisposed() || inputEnded()) {
      throw new Error('Speex input track ended during startup');
    }
    return { track: outputTrack, failure, dispose: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
