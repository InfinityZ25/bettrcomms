import { Call } from '@wailsio/runtime';
import { nativePageToken } from './nativeMedia';

// Stable Wails binding IDs registered by ios_auth_bridge.go.
export const iosNativeBinding = {
  callAudioStart: 0xBC160101,
  callAudioStop: 0xBC160102,
  screenStart: 0xBC160103,
  screenStop: 0xBC160104,
  metaConnect: 0xBC160105,
  metaStart: 0xBC160106,
  metaStop: 0xBC160107,
} as const;

export async function callIOSNative(method: number): Promise<void> {
  await Call.ByID(method, nativePageToken());
}
