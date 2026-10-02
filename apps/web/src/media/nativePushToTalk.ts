import { nativeInputCapabilities, nativeShortcutSupported, startNativeInput, startNativeShortcuts, heartbeatNativeInput, stopNativeInput, onNativeInput, type CallShortcuts } from '../desktop/nativeMedia';
import { hasDesktopCapability, getDesktopCapabilities } from '../desktop/capabilities';
import type { TalkBinding } from './pushToTalk';

export type GlobalInputStatus = 'foreground' | 'connecting' | 'active' | 'unavailable';
interface Snapshot { sessionId: string; sequence: number; pressed: boolean; healthy: boolean; focused: boolean; muteCount?: number; deafenCount?: number }

export function isNativePushToTalk(): boolean {
  const capabilities = getDesktopCapabilities();
  return hasDesktopCapability('globalInput') || capabilities.platform === 'darwin' && capabilities.globalInput.state === 'experimental';
}

/** One native registration per call. Never forwards unselected input or text. */
export class NativePushToTalk {
  private disposed = false;
  private sessionId?: string;
  private sequence = -1;
  private pending?: Snapshot;
  private unlisten?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private polling = false;
  private muteCount = 0;
  private deafenCount = 0;
  private watchesTalk = true;

  constructor(
    private readonly onPressed: (pressed: boolean, focused?: boolean) => void,
    private readonly onStatus: (status: GlobalInputStatus, message: string) => void,
    private readonly onAction?: (action: 'mute' | 'deafen', focused: boolean) => void,
  ) {}

  async start(binding?: TalkBinding, actions?: Omit<CallShortcuts, 'talk'>): Promise<void> {
    this.onStatus('connecting', 'Starting global push-to-talk…');
    try {
      const capability = await nativeInputCapabilities();
      if (this.disposed) return;
      if (!capability.available) {
        this.onStatus('foreground', capability.detail);
        return;
      }
      const requested = [['talk', binding], ['mute', actions?.mute], ['deafen', actions?.deafen]] as const;
      const resolved = await Promise.all(requested.map(async ([name, value]) => ({
        name, value, supported: !value || await nativeShortcutSupported(value),
      })));
      if (this.disposed) return;
      const selected: CallShortcuts = {};
      for (const entry of resolved) if (entry.value && entry.supported) selected[entry.name] = entry.value;
      const skipped = resolved.filter(entry => entry.value && !entry.supported).map(entry => entry.name === 'talk' ? 'Push-to-talk' : entry.name);
      const warning = skipped.length ? skipped.join(', ') + ' uses foreground input only; the assigned key is unsupported globally on this platform.' : '';
      this.watchesTalk = Boolean(selected.talk);
      if (!selected.talk && !selected.mute && !selected.deafen) {
        this.onStatus('foreground', warning);
        return;
      }
      this.unlisten = await onNativeInput(snapshot => {
        if (this.disposed) return;
        if (!this.sessionId) this.pending = snapshot;
        else this.accept(snapshot);
      });
      if (this.disposed) { this.unlisten(); this.unlisten = undefined; return; }
      const initial = selected.mute || selected.deafen
        ? await startNativeShortcuts(selected)
        : await startNativeInput(selected.talk!);
      this.sessionId = initial.sessionId;
      if (this.disposed) { this.stopRegistration(); return; }
      this.onStatus(binding && !selected.talk ? 'foreground' : 'active', 'Global call shortcuts · Works while another app is focused' + (warning ? '. ' + warning : ''));
      this.accept(initial);
      if (this.pending) this.accept(this.pending);
      this.pending = undefined;
      if (!this.disposed) this.timer = setInterval(() => void this.heartbeat(), 1000);
    } catch (error) {
      const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      this.fail(detail || 'Global push-to-talk is unavailable. Update the desktop app and rejoin the call.');
    }
  }

  private accept(value: Snapshot): void {
    if (this.disposed || !value || value.sessionId !== this.sessionId || !Number.isSafeInteger(value.sequence) || typeof value.pressed !== 'boolean' || typeof value.healthy !== 'boolean') return;
    if (!value.healthy) { this.fail('Global push-to-talk stopped. Rejoin the call to reconnect.'); return; }
    if (value.sequence <= this.sequence) return;
    this.sequence = value.sequence;
    for (const action of ['mute', 'deafen'] as const) {
      const counter = value[action === 'mute' ? 'muteCount' : 'deafenCount'] ?? 0;
      const prior = action === 'mute' ? this.muteCount : this.deafenCount;
      if (!Number.isSafeInteger(counter) || counter < prior) continue;
      if ((counter - prior) % 2 === 1) this.onAction?.(action, value.focused !== false);
      if (action === 'mute') this.muteCount = counter; else this.deafenCount = counter;
    }
    if (this.watchesTalk) this.onPressed(value.pressed, value.focused !== false);
  }

  private async heartbeat(): Promise<void> {
    if (this.disposed || !this.sessionId || this.polling) return;
    this.polling = true;
    this.watchdog = setTimeout(() => this.fail('Global push-to-talk lost its connection. Rejoin the call.'), 2000);
    try {
      const snapshot = await heartbeatNativeInput(this.sessionId);
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
    if (sessionId) void stopNativeInput(sessionId).catch(() => {});
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
