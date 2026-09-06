import { invoke, isTauri } from '@tauri-apps/api/core';
import workletUrl from './nativeSystemAudio.worklet.js?url&no-inline';

export interface NativeSystemAudioCapabilities {
  available: boolean;
  applicationAudio?: boolean;
  detail: string;
}
export interface NativeSystemAudioTrack {
  track: MediaStreamTrack;
  dispose(): void;
  failure: Promise<Error>;
}
export type SystemAudioInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export async function createNativeSystemAudio(
  signal: AbortSignal,
  nativeInvoke: SystemAudioInvoke = invoke,
  sourceId?: string,
): Promise<NativeSystemAudioTrack> {
  if (!isTauri())
    throw new Error('Native system audio is available only in the desktop app');
  if (signal.aborted) throw new DOMException('Sharing canceled', 'AbortError');
  let sessionId: string | undefined;
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let track: MediaStreamTrack | undefined;
  let disposed = false;
  let pending = false;
  let report!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => {
    report = resolve;
  });
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', cleanup);
    if (node) {
      node.port.onmessage = null;
      node.port.postMessage({ type: 'stop' });
      node.disconnect();
      node.port.close();
    }
    track?.stop();
    destination?.disconnect();
    if (context) void context.close().catch(() => undefined);
    if (sessionId)
      void nativeInvoke('native_system_audio_stop', { sessionId }).catch(
        () => undefined,
      );
  };
  const check = () => {
    if (signal.aborted || disposed)
      throw new DOMException('Sharing canceled', 'AbortError');
  };
  try {
    if (sourceId) {
      const capabilities = await nativeInvoke('native_system_audio_capabilities') as NativeSystemAudioCapabilities;
      check();
      if (!capabilities.applicationAudio)
        throw new Error('Update the desktop app to use selected-application audio. This version can only share system audio.');
    }
    const session = (await nativeInvoke('native_system_audio_start', sourceId ? { sourceId } : undefined)) as {
      sessionId: string;
      sampleRate: number;
      channels: number;
      mode?: string;
    };
    sessionId = session.sessionId;
    signal.addEventListener('abort', cleanup, { once: true });
    check();
    if (sourceId && session.mode !== 'application')
      throw new Error('The selected application did not provide isolated audio. Choose a window or explicitly select system audio.');
    if (session.sampleRate !== 48000 || session.channels !== 2)
      throw new Error('Native system audio returned an unsupported format');
    context = new AudioContext({
      sampleRate: 48000,
      latencyHint: 'interactive',
    });
    if (context.sampleRate !== 48000)
      throw new Error('48 kHz system audio is unavailable');
    await context.audioWorklet.addModule(workletUrl);
    check();
    node = new AudioWorkletNode(context, 'bettercomms-system-audio', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    destination = context.createMediaStreamDestination();
    node.connect(destination);
    track = destination.stream.getAudioTracks()[0];
    track.contentHint = 'music';
    node.port.onmessage = () => {
      if (pending || disposed) return;
      pending = true;
      void nativeInvoke('native_system_audio_read', { sessionId })
        .then((value) => {
          if (disposed) return;
          const bytes =
            value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : ArrayBuffer.isView(value)
                ? new Uint8Array(
                    value.buffer,
                    value.byteOffset,
                    value.byteLength,
                  )
                : new Uint8Array(value as number[]);
          if (bytes.byteLength % 8 || bytes.byteLength > 192000)
            throw new Error('Invalid system audio packet');
          if (!bytes.byteLength) return;
          const samples = new Float32Array(bytes.slice().buffer);
          node!.port.postMessage({ type: 'audio', samples }, [samples.buffer]);
        })
        .catch((error) => {
          if (!disposed) {
            report(error instanceof Error ? error : new Error(String(error)));
            cleanup();
          }
        })
        .finally(() => {
          pending = false;
        });
    };
    await context.resume();
    check();
    return { track, dispose: cleanup, failure };
  } catch (error) {
    cleanup();
    throw error;
  }
}
