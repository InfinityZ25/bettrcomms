import { getDesktopRuntime } from './runtime';
import { nativePageToken } from './nativeMedia';
import type { NvidiaInvoke } from '../media/nvidiaDenoise';

/** Preserve the existing Worker protocol while selecting the native host. */
export const invokeNativeAudio: NvidiaInvoke = async (command, args = {}) => {
  const runtime = getDesktopRuntime();
  if (runtime === 'tauri') return (await import('@tauri-apps/api/core')).invoke(command, args);
  if (runtime !== 'wails') throw new Error('Native microphone processing requires a desktop host.');
  const token = nativePageToken();
  const api = await import('./wailsbindings/bettercomms/desktop-wails/nativemediaservice');
  switch (command) {
    case 'nvidia_stream_start':
      return api.AudioStreamStart(token, 'nvidia', Number(args.intensity ?? 1), Boolean(args.vad ?? false), 100);
    case 'deepfilter_stream_start':
      return api.AudioStreamStart(token, 'deepfilter', 1, false, Number(args.attenuationDb ?? 100));
    case 'nvidia_stream_stop':
    case 'deepfilter_stream_stop':
      if (typeof args.sessionId !== 'string' || !args.sessionId) throw new Error('Missing native audio session.');
      return api.AudioStreamStop(token, args.sessionId);
    default: throw new Error(`Unsupported native audio operation: ${command}`);
  }
};

type SetupOperation = 'nvidia_status' | 'nvidia_install_info' | 'nvidia_install' |
  'deepfilter_status' | 'deepfilter_install_info' | 'deepfilter_install';

/** Adapt Go status field names to the shared settings contract. */
export async function invokeAudioSetup<T>(command: SetupOperation): Promise<T> {
  const runtime = getDesktopRuntime();
  if (runtime === 'tauri') return (await import('@tauri-apps/api/core')).invoke<T>(command);
  if (runtime !== 'wails') throw new Error('Native microphone setup requires a desktop host.');
  const token = nativePageToken();
  const api = await import('./wailsbindings/bettercomms/desktop-wails/nativemediaservice');
  let result: unknown;
  switch (command) {
    case 'nvidia_status': {
      const status = await api.NvidiaStatus(token);
      result = { ready: status.available, detail: status.detail, sampleRate: 48000, frameSamples: status.frameSamples || null };
      break;
    }
    case 'deepfilter_status': {
      const status = await api.DeepfilterStatus(token);
      result = { ready: status.available, detail: status.detail, sampleRate: 48000, frameSamples: status.available ? 512 : null, adapterName: status.adapter || null };
      break;
    }
    case 'nvidia_install_info': result = await api.NvidiaInstallInfo(); break;
    case 'deepfilter_install_info': result = await api.DeepfilterInstallInfo(); break;
    case 'nvidia_install': result = await api.NvidiaInstall(token); break;
    case 'deepfilter_install': result = await api.DeepfilterInstall(token); break;
  }
  return result as T;
}
