import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallMicrophone, writeTalkSettings } from './pushToTalk';
import type { GlobalInputStatus } from './nativePushToTalk';

const native = vi.hoisted(() => ({ registrations: [] as {
  pressed: (pressed: boolean, focused?: boolean) => void;
  status: (status: GlobalInputStatus, message: string) => void;
  dispose: ReturnType<typeof vi.fn>;
}[] }));
vi.mock('./nativePushToTalk', () => ({
  isNativePushToTalk: () => true,
  NativePushToTalk: class {
    dispose = vi.fn();
    constructor(public pressed: (pressed: boolean, focused?: boolean) => void, public status: (status: GlobalInputStatus, message: string) => void) {
      native.registrations.push(this);
    }
    async start() { this.status('active', 'Global'); this.pressed(false); }
  },
}));

describe('native call microphone integration', () => {
  let input: CallMicrophone;
  let unsubscribe: () => void;
  const enabled = vi.fn();
  const current = () => native.registrations.at(-1)!;
  const configure = (on = true) => writeTalkSettings({ enabled: on, binding: { kind: 'keyboard', code: 'KeyV' } });
  beforeEach(() => {
    native.registrations.length = 0; enabled.mockClear();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hasFocus: () => false, hidden: false, activeElement: null }));
    vi.stubGlobal('Element', class { kind = 'input'; closest(selector: string) { return selector.includes(this.kind) ? this : null; } });
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    input = new CallMicrophone(enabled); unsubscribe = input.subscribe(() => {});
  });
  afterEach(() => { unsubscribe(); vi.unstubAllGlobals(); });

  it('never installs global input until explicitly enabled in a call', () => {
    input.start(); expect(native.registrations).toHaveLength(0);
    expect(enabled).toHaveBeenLastCalledWith(true);
    configure(); expect(native.registrations).toHaveLength(1);
    expect(enabled).toHaveBeenLastCalledWith(false);
  });
  it('keeps a native hold across blur and minimization until native release', () => {
    configure(); input.start(); current().pressed(true);
    window.dispatchEvent(new Event('blur'));
    Object.assign(document, { hidden: true }); document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(Object.assign(new Event('keyup'), { code: 'KeyV' }));
    expect(enabled).toHaveBeenLastCalledWith(true);
    current().pressed(false); expect(enabled).toHaveBeenLastCalledWith(false);
  });
  it('keeps manual mute and deafen above native input', () => {
    configure(); input.start(); current().pressed(true); input.toggleMute(); current().pressed(true);
    expect(enabled).toHaveBeenLastCalledWith(false);
    input.toggleMute(); expect(enabled).toHaveBeenLastCalledWith(false);
    current().pressed(false); current().pressed(true); expect(enabled).toHaveBeenLastCalledWith(true);
    input.toggleDeafen(); current().pressed(true); expect(enabled).toHaveBeenLastCalledWith(false);
    input.toggleDeafen(); expect(enabled).toHaveBeenLastCalledWith(false);
  });
  it('replaces registrations and ignores events from an old shortcut or call', () => {
    configure(); input.start(); const old = current(); old.pressed(true);
    writeTalkSettings({ enabled: true, binding: { kind: 'mouse', button: 3 } });
    expect(old.dispose).toHaveBeenCalledOnce(); old.pressed(true);
    expect(enabled).toHaveBeenLastCalledWith(false);
    current().pressed(true); input.stop(); old.pressed(true); current().pressed(true);
    expect(enabled).toHaveBeenLastCalledWith(false);
    expect(input.getSnapshot().globalStatus).toBe('foreground');
    input.start(); expect(enabled).toHaveBeenLastCalledWith(false);
  });
  it('does not transmit while using a focused BetterComms control', () => {
    configure(); input.start();
    Object.assign(document, { hasFocus: () => true, activeElement: new Element() });
    current().pressed(true, true); expect(enabled).toHaveBeenLastCalledWith(false);
    // Retained DOM focus must not block a press in a different native foreground window.
    current().pressed(false, false); current().pressed(true, false); expect(enabled).toHaveBeenLastCalledWith(true);
  });
  it('accepts foreground Ctrl after unmuting without requiring a matching global event', () => {
    writeTalkSettings({ enabled: true, binding: { kind: 'keyboard', code: 'ControlLeft' } }); input.start();
    const button = Object.assign(new Element(), { kind: 'button' });
    Object.assign(document, { activeElement: button });
    input.toggleMute(); input.toggleMute();
    const keyDown = Object.assign(new Event('keydown', { cancelable: true }), { code: 'ControlLeft', repeat: false });
    Object.defineProperty(keyDown, 'target', { value: button });
    window.dispatchEvent(keyDown);
    expect(enabled).toHaveBeenLastCalledWith(true);
    expect(input.getSnapshot()).toMatchObject({ muted: false, transmitting: true });
    window.dispatchEvent(Object.assign(new Event('keyup'), { code: 'ControlLeft' }));
    current().pressed(true, true); // Delayed foreground hook events cannot reopen a released key.
    expect(enabled).toHaveBeenLastCalledWith(false);
  });
  it('releases a foreground hold on blur and still accepts a fresh background hold', () => {
    configure(); input.start();
    window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyV', repeat: false }));
    expect(enabled).toHaveBeenLastCalledWith(true);
    window.dispatchEvent(new Event('blur'));
    expect(enabled).toHaveBeenLastCalledWith(false);
    current().pressed(true, false); expect(enabled).toHaveBeenLastCalledWith(true);
    current().pressed(false, false); expect(enabled).toHaveBeenLastCalledWith(false);
  });
  it('uses the clicked target for foreground mouse input instead of stale button focus', () => {
    writeTalkSettings({ enabled: true, binding: { kind: 'mouse', button: 0 } }); input.start();
    const button = Object.assign(new Element(), { kind: 'button' });
    Object.assign(document, { activeElement: button });
    current().pressed(true, true); expect(enabled).toHaveBeenLastCalledWith(false);
    const controlClick = Object.assign(new Event('mousedown', { cancelable: true }), { button: 0 });
    Object.defineProperty(controlClick, 'target', { value: button });
    window.dispatchEvent(controlClick); expect(enabled).toHaveBeenLastCalledWith(false);
    window.dispatchEvent(Object.assign(new Event('mousedown', { cancelable: true }), { button: 0 }));
    expect(enabled).toHaveBeenLastCalledWith(true);
    window.dispatchEvent(Object.assign(new Event('mouseup'), { button: 0 }));
    expect(enabled).toHaveBeenLastCalledWith(false);
  });
  it('fails closed instead of falling back to DOM input after a native error', () => {
    configure(); input.start(); current().pressed(true); current().status('unavailable', 'Disconnected');
    window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyV', repeat: false }));
    expect(enabled).toHaveBeenLastCalledWith(false);
    expect(input.getSnapshot().globalStatus).toBe('unavailable');
  });
  it('cleans up on disable and page unload', () => {
    configure(); input.start(); const first = current(); configure(false);
    expect(first.dispose).toHaveBeenCalledOnce(); expect(enabled).toHaveBeenLastCalledWith(true);
    configure(); current().pressed(true); window.dispatchEvent(new Event('pagehide'));
    expect(current().dispose).toHaveBeenCalledOnce(); expect(enabled).toHaveBeenLastCalledWith(false);
  });
});
