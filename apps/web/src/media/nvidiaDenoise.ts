import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DenoisedTrack } from './denoise';
import NvidiaAudioWorker from './nvidiaDenoise.worker?worker';
import nvidiaWorkletUrl from './nvidiaDenoise.worklet.js?url&no-inline';

export interface NvidiaSession {
  sessionId: string;
  frameSamples: number;
  sampleRate: number;
  port: number;
  token: string;
}
export type NvidiaInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
export interface NvidiaDenoisedTrack extends DenoisedTrack {
  readonly diagnostics: {
    processedFrames: number;
    underruns: number;
    droppedFrames: number;
    bufferMs: number;
  };
}
export interface NvidiaDenoiseOptions {
  intensity?: number;
  vad?: boolean;
  /** Internal transport customization used by compatible native denoisers. */
  commandPrefix?: 'nvidia' | 'deepfilter';
  displayName?: 'NVIDIA' | 'DeepFilterNet';
  startArgs?: Record<string, unknown>;
}
export async function createNvidiaDenoiser(
  rawTrack: MediaStreamTrack,
  nativeInvoke: NvidiaInvoke = invoke,
  options: NvidiaDenoiseOptions = {},
): Promise<NvidiaDenoisedTrack> {
  const commandPrefix = options.commandPrefix ?? 'nvidia';
  const displayName = options.displayName ?? 'NVIDIA';
  if (rawTrack.kind !== 'audio' || rawTrack.readyState === 'ended')
    throw new Error(`${displayName} requires a live microphone track`);
  if (!isTauri())
    throw new Error(
      `${displayName} denoising is available only in the desktop app`,
    );
  const session = (await nativeInvoke(
    `${commandPrefix}_stream_start`,
    options.startArgs ?? {
      intensity: options.intensity ?? 1,
      vad: options.vad ?? false,
    },
  )) as NvidiaSession;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let track: MediaStreamTrack | undefined;
  let worker: Worker | undefined;
  let disposed = false;
  let reportFailure!: (error: unknown) => void;
  let rejectStartup: ((error: Error) => void) | undefined;
  const diagnostics = {
    processedFrames: 0,
    underruns: 0,
    droppedFrames: 0,
    bufferMs: 40,
  };
  const failure = new Promise<unknown>((resolve) => {
    reportFailure = resolve;
  });
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    rawTrack.removeEventListener('ended', rawEnded);
    worker?.terminate();
    track?.stop();
    source?.disconnect();
    node?.disconnect();
    destination?.disconnect();
    if (context) void context.close().catch(() => undefined);
    void nativeInvoke(`${commandPrefix}_stream_stop`, {
      sessionId: session.sessionId,
    }).catch(() => undefined);
  };
  const rawEnded = () => {
    const error = new Error('The microphone was disconnected');
    rejectStartup?.(error);
    reportFailure(error);
    cleanup();
  };
  try {
    rawTrack.addEventListener('ended', rawEnded, { once: true });
    if ((rawTrack as MediaStreamTrack).readyState === 'ended')
      throw new Error('The microphone was disconnected');
    if (
      session.sampleRate !== 48000 ||
      !Number.isInteger(session.frameSamples) ||
      session.frameSamples < 1 ||
      session.frameSamples > 960
    )
      throw new Error(`${displayName} returned an unsupported audio format`);
    worker = new NvidiaAudioWorker();
    await new Promise<void>((resolve, reject) => {
      rejectStartup = reject;
      const failed = (reason: string) => {
        reject(new Error(reason));
        reportFailure(new Error(reason));
        cleanup();
      };
      worker!.onerror = () => failed('NVIDIA audio worker failed');
      worker!.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          rejectStartup = undefined;
          resolve();
        } else if (data.type === 'diagnostics')
          diagnostics.processedFrames = data.processedFrames;
        else if (data.type === 'playout') {
          diagnostics.underruns = data.underruns;
          diagnostics.droppedFrames = data.droppedFrames;
          diagnostics.bufferMs = data.bufferMs;
        } else if (data.type === 'failure') failed(data.reason);
      };
      worker!.postMessage({ type: 'initialize', session, displayName });
    });
    context = new AudioContext({
      latencyHint: 'interactive',
      sampleRate: 48000,
    });
    await context.audioWorklet.addModule(nvidiaWorkletUrl);
    if (disposed)
      throw new Error('NVIDIA audio connection closed during startup');
    source = context.createMediaStreamSource(new MediaStream([rawTrack]));
    node = new AudioWorkletNode(context, 'bettercomms-nvidia-denoiser', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { frameSamples: session.frameSamples },
    });
    destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    // Transfer the channel itself: no audio frame or response crosses the UI thread.
    worker.postMessage({ type: 'attach', port: node.port }, [node.port]);
    source.connect(node);
    node.connect(destination);
    track = destination.stream.getAudioTracks()[0];
    if (!track)
      throw new Error('NVIDIA denoising did not produce an audio track');
    await context.resume();
    if (disposed) throw new Error('NVIDIA audio stopped during startup');
    return { track, failure, diagnostics, dispose: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
