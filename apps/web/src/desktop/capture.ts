import { getDesktopRuntime } from './runtime';
import { nativePageToken } from './nativeMedia';
import type { StartOptions } from './wailsbindings/bettercomms/desktop-wails/internal/native/nativescreen/models';
import type { IceCandidate, IceServer } from './wailsbindings/bettercomms/desktop-wails/internal/native/nativertc/models';

/** Decode only bounded Go []byte values; null is Go's empty/nil slice. */
export function decodeNativeBytes(value: string | null, maxBytes: number): ArrayBuffer {
  if (value === null) return new ArrayBuffer(0);
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4) throw new Error('Native packet exceeds its size limit.');
  const decoded = atob(value);
  if (decoded.length > maxBytes) throw new Error('Native packet exceeds its size limit.');
  return Uint8Array.from(decoded, c => c.charCodeAt(0)).buffer;
}

/** Adapt the shared capture contract, without letting callers choose Go methods. */
export async function invokeNativeCapture<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (getDesktopRuntime() !== 'wails') return (await import('@tauri-apps/api/core')).invoke<T>(command, args);
  const token = nativePageToken();
  const api = await import('./wailsbindings/bettercomms/desktop-wails/nativemediaservice');
  const text = (name: string) => {
    if (typeof args[name] !== 'string') throw new Error(`Missing native ${name}.`);
    return args[name] as string;
  };
  let result: unknown;
  switch (command) {
    case 'ffmpeg_install_info': result = await api.FfmpegInstallInfo(); break;
    case 'ffmpeg_install': result = await api.FfmpegInstall(token); break;
    case 'native_screen_capabilities': {
      const caps = await api.NativeScreenCapabilities();
      result = { ...caps, encoders: caps.encoders ?? [] }; break;
    }
    case 'native_screen_sources': result = { sources: await api.NativeScreenSources(token) ?? [] }; break;
    case 'native_screen_thumbnail': result = decodeNativeBytes(await api.NativeScreenThumbnail(token, text('sourceId')), 512 * 1024); break;
    case 'native_screen_start': result = { ...args, ...await api.NativeScreenStart(token, args as unknown as StartOptions) }; break;
    case 'native_screen_stop': result = await api.NativeScreenStop(token, text('sessionId')); break;
    case 'native_screen_diagnostics': result = await api.NativeScreenDiagnostics(token, text('sessionId')); break;
    case 'native_screen_peer_offer': {
      const offer = await api.NativeScreenPeerOffer(token, text('sessionId'), text('peerId'), (args.iceServers ?? []) as IceServer[], Boolean(args.directOnly));
      result = { type: 'offer', sdp: offer.sdp }; break;
    }
    case 'native_screen_peer_answer': {
      const description = args.description as RTCSessionDescriptionInit;
      if (description?.type !== 'answer' || typeof description.sdp !== 'string') throw new Error('Invalid native peer answer.');
      result = await api.NativeScreenPeerAnswer(token, text('sessionId'), text('peerId'), description.sdp); break;
    }
    case 'native_screen_peer_candidate':
      if (args.candidate) result = await api.NativeScreenPeerCandidate(token, text('sessionId'), text('peerId'), args.candidate as IceCandidate);
      break;
    case 'native_screen_peer_remove': result = await api.NativeScreenPeerRemove(token, text('sessionId'), text('peerId')); break;
    case 'native_system_audio_capabilities': result = await api.NativeSystemAudioCapabilities(); break;
    case 'native_system_audio_start': result = await api.NativeSystemAudioStart(token, { sourceId: typeof args.sourceId === 'string' ? args.sourceId : '', excludeCallAudio: args.excludeCallAudio !== false }); break;
    case 'native_system_audio_read': result = decodeNativeBytes(await api.NativeSystemAudioRead(token, text('sessionId')), 192000); break;
    case 'native_system_audio_stop': result = await api.NativeSystemAudioStop(token, text('sessionId')); break;
    case 'native_screen_recording_start': result = await api.NativeScreenRecordingStart(token, text('sessionId')); break;
    case 'native_screen_recording_stop': result = { ...await api.NativeScreenRecordingStop(token, text('recordingId')), mimeType: 'video/mp4' }; break;
    case 'native_screen_recording_read': {
      const length = Number(args.maxBytes), offset = Number(args.offset);
      if (!Number.isInteger(length) || length < 1 || length > 256 * 1024 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid native recording read range.');
      result = decodeNativeBytes(await api.NativeScreenRecordingRead(token, text('assetId'), offset, length), length); break;
    }
    case 'native_screen_recording_release': result = await api.NativeScreenRecordingRelease(token, text('assetId')); break;
    default: throw new Error(`Unsupported native capture operation: ${command}`);
  }
  return result as T;
}

export async function onNativeCaptureEnded(handler: (event: { payload: { sessionId: string; reason: string } }) => void): Promise<() => void> {
  if (getDesktopRuntime() === 'wails') {
    const { Events } = await import('@wailsio/runtime');
    return Events.On('native-screen-ended', event => handler({ payload: event.data as { sessionId: string; reason: string } }));
  }
  return (await import('@tauri-apps/api/event')).listen('native-screen-ended', handler);
}
