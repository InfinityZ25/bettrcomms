export type TalkBinding = { kind: 'keyboard'; code: string } | { kind: 'mouse'; button: number };
export interface TalkSettings { enabled: boolean; binding: TalkBinding }
const storageKey = 'bc-push-to-talk';
const changeEvent = 'bc-push-to-talk';
const defaults: TalkSettings = { enabled: false, binding: { kind: 'keyboard', code: 'Space' } };

export function canBindKey(code: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(code) && !['Escape', 'Tab', 'MetaLeft', 'MetaRight', 'Unidentified'].includes(code);
}

export function readTalkSettings(): TalkSettings {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    const binding = value?.binding;
    if (typeof value?.enabled === 'boolean' && (
      (binding?.kind === 'keyboard' && typeof binding.code === 'string' && canBindKey(binding.code)) ||
      (binding?.kind === 'mouse' && Number.isInteger(binding.button) && binding.button >= 0 && binding.button <= 4)
    )) return { enabled: value.enabled, binding };
  } catch { /* Invalid or unavailable storage uses open-mic defaults. */ }
  return { ...defaults, binding: { ...defaults.binding } };
}

export function writeTalkSettings(settings: TalkSettings): void {
  localStorage.setItem(storageKey, JSON.stringify(settings));
  window.dispatchEvent(new Event(changeEvent));
}

export function talkBindingLabel(binding: TalkBinding): string {
  if (binding.kind === 'mouse') return ['Mouse left', 'Mouse middle', 'Mouse right', 'Mouse back', 'Mouse forward'][binding.button]!;
  return binding.code.replace(/^Key/, '').replace(/^Digit/, '').replace(/(Left|Right)$/, ' $1');
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [data-talk-binding]'));
}

/** Owns the call input gate; React only observes its snapshot. */
export class CallMicrophone {
  private listeners = new Set<() => void>();
  private state = { settings: readTalkSettings(), active: false, held: false, manualMuted: false, deafened: false, muted: false };

  constructor(private readonly setEnabled: (enabled: boolean) => void) {}

  getSnapshot = () => this.state;

  private update(patch: Partial<typeof this.state>): void {
    const next = { ...this.state, ...patch };
    next.muted = next.manualMuted || next.deafened || (next.settings.enabled && !next.held);
    this.state = next;
    this.setEnabled(next.active && !next.muted);
    for (const listener of this.listeners) listener();
  }

  start(): void {
    this.update({ settings: readTalkSettings(), active: true, held: false, manualMuted: false, deafened: false });
  }

  stop(): void {
    this.update({ active: false, held: false, manualMuted: false, deafened: false });
  }

  toggleMute(): void {
    if (this.state.active && !this.state.deafened)
      this.update({ manualMuted: !this.state.manualMuted, held: false });
  }

  toggleDeafen(): void {
    if (this.state.active) this.update({ deafened: !this.state.deafened, held: false });
  }

  private release = () => {
    if (this.state.held) this.update({ held: false });
  };
  private visibility = () => { if (document.hidden) this.release(); };
  private focus = (event: FocusEvent) => { if (isInteractive(event.target)) this.release(); };
  private settingsChanged = () => this.update({ settings: readTalkSettings(), held: false });
  private storageChanged = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) this.settingsChanged();
  };

  private press(event: KeyboardEvent | MouseEvent): void {
    if (!this.state.active || !this.state.settings.enabled || this.state.manualMuted || this.state.deafened || document.hidden || isInteractive(event.target)) return;
    event.preventDefault();
    if (!this.state.held) this.update({ held: true });
  }
  private keyDown = (event: KeyboardEvent) => {
    const binding = this.state.settings.binding;
    if (binding.kind !== 'keyboard' || event.code !== binding.code || event.isComposing || event.repeat) return;
    this.press(event);
  };
  private keyUp = (event: KeyboardEvent) => {
    const binding = this.state.settings.binding;
    if (binding.kind === 'keyboard' && event.code === binding.code) this.release();
  };
  private mouseDown = (event: MouseEvent) => {
    const binding = this.state.settings.binding;
    if (binding.kind === 'mouse' && event.button === binding.button) this.press(event);
  };
  private mouseUp = (event: MouseEvent) => {
    const binding = this.state.settings.binding;
    if (binding.kind === 'mouse' && event.button === binding.button) {
      if (this.state.held) event.preventDefault();
      this.release();
    }
  };
  private mouseDefault = (event: MouseEvent) => {
    const { settings, active } = this.state;
    if (active && settings.enabled && settings.binding.kind === 'mouse' && settings.binding.button === event.button && !isInteractive(event.target)) event.preventDefault();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      window.addEventListener('keydown', this.keyDown);
      window.addEventListener('keyup', this.keyUp);
      window.addEventListener('mousedown', this.mouseDown);
      window.addEventListener('mouseup', this.mouseUp);
      window.addEventListener('contextmenu', this.mouseDefault);
      window.addEventListener('auxclick', this.mouseDefault);
      window.addEventListener('blur', this.release);
      window.addEventListener('pagehide', this.release);
      window.addEventListener('focusin', this.focus);
      document.addEventListener('visibilitychange', this.visibility);
      window.addEventListener(changeEvent, this.settingsChanged);
      window.addEventListener('storage', this.storageChanged);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      window.removeEventListener('keydown', this.keyDown);
      window.removeEventListener('keyup', this.keyUp);
      window.removeEventListener('mousedown', this.mouseDown);
      window.removeEventListener('mouseup', this.mouseUp);
      window.removeEventListener('contextmenu', this.mouseDefault);
      window.removeEventListener('auxclick', this.mouseDefault);
      window.removeEventListener('blur', this.release);
      window.removeEventListener('pagehide', this.release);
      window.removeEventListener('focusin', this.focus);
      document.removeEventListener('visibilitychange', this.visibility);
      window.removeEventListener(changeEvent, this.settingsChanged);
      window.removeEventListener('storage', this.storageChanged);
      this.stop();
    };
  };
}
