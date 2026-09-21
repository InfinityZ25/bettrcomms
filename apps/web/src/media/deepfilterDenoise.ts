import { invokeNativeAudio } from '../desktop/audio';
import {
  createNvidiaDenoiser,
  type NvidiaDenoisedTrack,
  type NvidiaInvoke,
} from './nvidiaDenoise';

/** DeepFilterNet uses the same bounded 48 kHz worker/worklet transport as NVIDIA. */
export async function createDeepfilterDenoiser(
  rawTrack: MediaStreamTrack,
  nativeInvoke: NvidiaInvoke = invokeNativeAudio,
  attenuationDb = 100,
): Promise<NvidiaDenoisedTrack> {
  return createNvidiaDenoiser(rawTrack, nativeInvoke, {
    commandPrefix: 'deepfilter',
    displayName: 'DeepFilterNet',
    startArgs: {
      attenuationDb: Math.min(100, Math.max(0, attenuationDb)),
    },
  });
}
