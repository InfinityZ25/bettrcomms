import { getDesktopRuntime, readDesktopBootReport } from './runtime';
import type { TalkBinding } from '../media/pushToTalk';
import type { Binding } from './wailsbindings/bettercomms/desktop-wails/internal/native/pushtotalk/models';

const service = () => import('./wailsbindings/bettercomms/desktop-wails/nativemediaservice');

/** Only the token injected into the validated boot document can start native work. */
export function nativePageToken(): string {
  const token = readDesktopBootReport()?.pageToken;
  if (!token) throw new Error('The desktop host did not authorise this page. Restart BetterComms.');
  return token;
}

export function hasNativeMediaHost(): boolean {
  return getDesktopRuntime() !== 'browser';
}

export interface InputSnapshot {
  sessionId: string;
  sequence: number;
  pressed: boolean;
  healthy: boolean;
  focused: boolean;
  muteCount?: number;
  deafenCount?: number;
}

export interface CallShortcuts { talk?: TalkBinding; mute?: TalkBinding; deafen?: TalkBinding }

export async function startNativeShortcuts(bindings: CallShortcuts): Promise<InputSnapshot> {
  if (getDesktopRuntime() !== 'wails') throw new Error('Native call shortcuts require the desktop app.');
  return (await service()).CallShortcutsStart(nativePageToken(), bindings as Parameters<Awaited<ReturnType<typeof service>>['CallShortcutsStart']>[1]);
}

export async function nativeShortcutPermission(request = false): Promise<{ available: boolean; granted: boolean; detail: string }> {
  const api = await service();
  return request ? api.CallShortcutRequestPermission(nativePageToken()) : api.CallShortcutPermission(nativePageToken());
}

export async function nativeInputCapabilities(): Promise<{ available: boolean; detail: string }> {
  if (getDesktopRuntime() === 'wails') return (await service()).PushToTalkCapabilities();
  return { available: false, detail: 'Global push-to-talk requires a desktop host.' };
}

export async function startNativeInput(binding: TalkBinding): Promise<InputSnapshot> {
  if (getDesktopRuntime() === 'wails') {
    const token = nativePageToken();
    return (await service()).PushToTalkStart(token, binding as Binding);
  }
  throw new Error('Global push-to-talk requires a desktop host.');
}

export async function heartbeatNativeInput(sessionId: string): Promise<InputSnapshot> {
  if (getDesktopRuntime() === 'wails') return (await service()).PushToTalkHeartbeat(nativePageToken(), sessionId);
  throw new Error('Global push-to-talk requires a desktop host.');
}

export async function stopNativeInput(sessionId: string): Promise<void> {
  if (getDesktopRuntime() === 'wails') return (await service()).PushToTalkStop(nativePageToken(), sessionId);
}

export async function onNativeInput(handler: (snapshot: InputSnapshot) => void): Promise<() => void> {
  const name = 'bc-global-push-to-talk';
  if (getDesktopRuntime() === 'wails') {
    const { Events } = await import('@wailsio/runtime');
    return Events.On(name, event => handler(event.data as InputSnapshot));
  }
  throw new Error('Global push-to-talk requires a desktop host.');
}

export type NativeExportFormat = 'mp4' | 'wav' | 'mp3';
export interface NativeExportCapabilities {
  available: boolean;
  detail: string;
  formats: { id: NativeExportFormat; extension: string; label: string; available: boolean }[];
}
export interface ExportGrant { exportId: string }
export interface NativeExportResult { fileName: string; path: string }

export async function nativeExportCapabilities(): Promise<NativeExportCapabilities | null> {
  if (getDesktopRuntime() === 'wails') {
    const report = await (await service()).RecordingConversionCapabilities();
    const formats = report.formats.filter((value): value is NativeExportCapabilities['formats'][number] =>
      ['mp4', 'wav', 'mp3'].includes(value.id));
    const available = formats.some(format => format.available);
    return { formats, available, detail: available ? 'Native conversion is available.' : 'Install the FFmpeg runtime to convert recordings.' };
  }
  return null;
}

export async function beginNativeExport(fileName: string, sizeBytes: number, format?: NativeExportFormat): Promise<ExportGrant | null> {
  if (getDesktopRuntime() === 'wails') {
    const token = nativePageToken();
    const api = await service();
    return format ? api.RecordingConversionBegin(token, fileName, sizeBytes, format) : api.RecordingExportBegin(token, fileName, sizeBytes);
  }
  throw new Error('Native export requires a desktop host.');
}

/** Go []byte bindings use base64. Encode bounded pieces without spreading a large array. */
export function encodeNativeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export async function appendNativeExport(exportId: string, offset: number, bytes: Uint8Array): Promise<void> {
  if (getDesktopRuntime() === 'wails') {
    const token = nativePageToken();
    return (await service()).RecordingExportAppend(token, exportId, offset, encodeNativeBytes(bytes));
  }
  throw new Error('Native export requires a desktop host.');
}

export async function finishNativeExport(exportId: string, _converted = false): Promise<NativeExportResult> {
  if (getDesktopRuntime() === 'wails') {
    const token = nativePageToken();
    // The Go grant remembers the format; both paths share the same commit operation.
    return (await service()).RecordingExportFinish(token, exportId);
  }
  throw new Error('Native export requires a desktop host.');
}

export async function abortNativeExport(exportId: string): Promise<void> {
  if (getDesktopRuntime() === 'wails') {
    const token = nativePageToken();
    return (await service()).RecordingExportAbort(token, exportId);
  }
}
