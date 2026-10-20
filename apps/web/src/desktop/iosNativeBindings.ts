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
  metaSender: 0xBC160108,
  screenSender: 0xBC160109,
} as const;

export async function callIOSNative(method: number, ...args: unknown[]): Promise<void> {
  await Call.ByID(method, nativePageToken(), ...args);
}

export async function callIOSMetaSender<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return await Call.ByID(iosNativeBinding.metaSender, nativePageToken(), command, args) as T;
}

export async function callIOSScreenSender<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return await Call.ByID(iosNativeBinding.screenSender, nativePageToken(), command, args) as T;
}
