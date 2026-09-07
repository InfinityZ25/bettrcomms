import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CallMicrophone, readTalkSettings, writeTalkSettings } from './pushToTalk';

describe('call microphone input gate', () => {
  let input: CallMicrophone;
  let enabled: Mock<(enabled: boolean) => void>;
  let unsubscribe: () => void;
  const key = (type: string, code = 'KeyV', extra = {}) => window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat: false, ...extra }));
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal('Element', class {});
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    enabled = vi.fn();
    input = new CallMicrophone(enabled);
    unsubscribe = input.subscribe(() => {});
  });
  afterEach(() => { unsubscribe(); vi.unstubAllGlobals(); });
  const enablePTT = () => writeTalkSettings({ enabled: true, binding: { kind: 'keyboard', code: 'KeyV' } });

  it('defaults to open microphone and ignores the shortcut', () => {
    expect(readTalkSettings().enabled).toBe(false);
    input.start(); key('keydown'); key('keyup');
    expect(enabled).toHaveBeenLastCalledWith(true);
  });
  it('validates saved preferences and preserves keyboard and mouse bindings', () => {
    localStorage.setItem('bc-push-to-talk', '{invalid');
    expect(readTalkSettings().enabled).toBe(false);
    localStorage.setItem('bc-push-to-talk', JSON.stringify({ enabled: true, binding: { kind: 'mouse', button: 8 } }));
    expect(readTalkSettings().enabled).toBe(false);
    enablePTT();
    expect(readTalkSettings().binding).toEqual({ kind: 'keyboard', code: 'KeyV' });
    writeTalkSettings({ enabled: false, binding: { kind: 'mouse', button: 4 } });
    expect(readTalkSettings()).toEqual({ enabled: false, binding: { kind: 'mouse', button: 4 } });
  });
  it('starts silent, opens only for its binding and closes on keyup', () => {
    enablePTT(); input.start();
    expect(enabled).toHaveBeenLastCalledWith(false);
    key('keydown', 'KeyB');
    expect(enabled).toHaveBeenLastCalledWith(false);
    key('keydown'); expect(enabled).toHaveBeenLastCalledWith(true);
    key('keyup'); expect(enabled).toHaveBeenLastCalledWith(false);
  });
  it('keeps push-to-talk waiting separate from manual mute', () => {
    enablePTT(); input.start();
    expect(input.getSnapshot()).toMatchObject({ muted: false, transmitting: false });
    key('keydown');
    expect(input.getSnapshot()).toMatchObject({ muted: false, transmitting: true });
    key('keyup'); input.toggleMute();
    expect(input.getSnapshot()).toMatchObject({ muted: true, transmitting: false });
    input.toggleMute();
    expect(input.getSnapshot()).toMatchObject({ muted: false, transmitting: false });
  });
  it('releases on blur and requires a fresh press after autorepeat', () => {
    enablePTT(); input.start(); key('keydown');
    window.dispatchEvent(new Event('blur'));
    expect(enabled).toHaveBeenLastCalledWith(false);
    key('keydown', 'KeyV', { repeat: true });
    expect(enabled).toHaveBeenLastCalledWith(false);
    key('keyup'); key('keydown'); expect(enabled).toHaveBeenLastCalledWith(true);
  });
  it('releases on hidden page and pagehide', () => {
    enablePTT(); input.start(); key('keydown');
    Object.assign(document, { hidden: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(enabled).toHaveBeenLastCalledWith(false);
    Object.assign(document, { hidden: false });
    key('keydown'); window.dispatchEvent(new Event('pagehide'));
    expect(enabled).toHaveBeenLastCalledWith(false);
  });
  it('manual mute and deafen override holding and preserve manual mute', () => {
    enablePTT(); input.start(); key('keydown'); input.toggleMute();
    key('keyup'); key('keydown'); expect(enabled).toHaveBeenLastCalledWith(false);
    input.toggleDeafen(); input.toggleDeafen();
    expect(input.getSnapshot().manualMuted).toBe(true);
    input.toggleMute(); expect(enabled).toHaveBeenLastCalledWith(false);
    key('keyup'); key('keydown'); expect(enabled).toHaveBeenLastCalledWith(true);
    input.toggleDeafen(); input.toggleDeafen();
    expect(enabled).toHaveBeenLastCalledWith(false);
  });
  it('supports mouse buttons and resets held state on rebinding and disable', () => {
    enablePTT(); input.start(); key('keydown');
    writeTalkSettings({ enabled: true, binding: { kind: 'mouse', button: 3 } });
    expect(enabled).toHaveBeenLastCalledWith(false);
    window.dispatchEvent(Object.assign(new Event('mousedown'), { button: 3 }));
    expect(enabled).toHaveBeenLastCalledWith(true);
    window.dispatchEvent(Object.assign(new Event('mouseup'), { button: 3 }));
    expect(enabled).toHaveBeenLastCalledWith(false);
    writeTalkSettings({ enabled: false, binding: { kind: 'mouse', button: 3 } });
    expect(enabled).toHaveBeenLastCalledWith(true);
  });
  it('stops on disconnect and removes listeners on unsubscribe', () => {
    enablePTT(); input.start(); key('keydown'); input.stop();
    key('keydown'); expect(enabled).toHaveBeenLastCalledWith(false);
    input.start(); expect(enabled).toHaveBeenLastCalledWith(false);
    unsubscribe(); enabled.mockClear(); key('keydown');
    expect(enabled).not.toHaveBeenCalled();
  });
});
