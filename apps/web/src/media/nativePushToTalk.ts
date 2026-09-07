import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { TalkBinding } from './pushToTalk';

export type GlobalInputStatus = 'foreground' | 'connecting' | 'active' | 'unavailable';
interface Snapshot { sessionId: string; sequence: number; pressed: boolean; healthy: boolean; focused: boolean }
const EVENT = 'bc-global-push-to-talk';

export function isNativePushToTalk(): boolean { return isTauri(); }

/** One native registration per call. Never forwards unselected input or text. */
export class NativePushToTalk {
  private disposed = false;
  private sessionId?: string;
  private sequence = -1;
  private pending?: Snapshot;
  private unlisten?: UnlistenFn;
  private timer?: ReturnType<typeof setInterval>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private polling = false;

  constructor(
    private readonly onPressed: (pressed: boolean, focused?: boolean) => void,
    private readonly onStatus: (status: GlobalInputStatus, message: string) => void,
  ) {}

  async start(binding: TalkBinding): Promise<void> {
    this.onStatus('connecting', 'Starting global push-to-talk…');
    try {
      const capability = await invoke<{ available: boolean; detail: string }>('push_to_talk_capabilities');
      if (this.disposed) return;
      if (!capability.available) {
        this.onStatus('foreground', capability.detail);
        return;
      }
      this.unlisten = await listen<Snapshot>(EVENT, event => {
        if (this.disposed) return;
        if (!this.sessionId) this.pending = event.payload;
        else this.accept(event.payload);
      });
      if (this.disposed) { this.unlisten(); this.unlisten = undefined; return; }
      const initial = await invoke<Snapshot>('push_to_talk_start', { binding });
      this.sessionId = initial.sessionId;
      if (this.disposed) { this.stopRegistration(); return; }
      this.onStatus('active', 'Global push-to-talk · Works while another app is focused');
      this.accept(initial);
      if (this.pending) this.accept(this.pending);
      this.pending = undefined;
      if (!this.disposed) this.timer = setInterval(() => void this.heartbeat(), 1000);
    } catch (error) {
      this.fail(typeof error === 'string' ? error : 'Global push-to-talk is unavailable. Update the desktop app and rejoin the call.');
    }
  }

  private accept(value: Snapshot): void {
    if (this.disposed || !value || value.sessionId !== this.sessionId || !Number.isSafeInteger(value.sequence) || typeof value.pressed !== 'boolean' || typeof value.healthy !== 'boolean') return;
    if (!value.healthy) { this.fail('Global push-to-talk stopped. Rejoin the call to reconnect.'); return; }
    if (value.sequence <= this.sequence) return;
    this.sequence = value.sequence;
    this.onPressed(value.pressed, value.focused !== false);
  }

  private async heartbeat(): Promise<void> {
    if (this.disposed || !this.sessionId || this.polling) return;
    this.polling = true;
    this.watchdog = setTimeout(() => this.fail('Global push-to-talk lost its connection. Rejoin the call.'), 2000);
    try {
      const snapshot = await invoke<Snapshot>('push_to_talk_heartbeat', { sessionId: this.sessionId });
      this.accept(snapshot);
    } catch { this.fail('Global push-to-talk lost its connection. Rejoin the call.'); }
    finally { clearTimeout(this.watchdog); this.watchdog = undefined; this.polling = false; }
  }

  private fail(message: string): void {
    if (this.disposed) return;
    this.dispose();
    this.onStatus('unavailable', message);
  }

  private stopRegistration(): void {
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    if (sessionId) void invoke('push_to_talk_stop', { sessionId }).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.watchdog);
    this.unlisten?.();
    this.unlisten = undefined;
    this.onPressed(false);
    this.stopRegistration();
  }
}
