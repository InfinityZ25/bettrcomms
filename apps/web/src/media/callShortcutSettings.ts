import { canBindKey, type TalkBinding } from './pushToTalk';

export interface CallShortcutSettings { mute?: TalkBinding; deafen?: TalkBinding }
export const shortcutChangeEvent = 'bc-call-shortcuts';
const storageKey = 'bc-call-shortcuts';
export function validShortcut(binding: unknown): binding is TalkBinding {
  if (!binding || typeof binding !== 'object') return false;
  const value = binding as Record<string, unknown>;
  return value.kind === 'keyboard' && typeof value.code === 'string' && canBindKey(value.code)
    || value.kind === 'mouse' && Number.isInteger(value.button) && Number(value.button) >= 0 && Number(value.button) <= 4;
}
export function readCallShortcuts(): CallShortcutSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return { ...(validShortcut(saved?.mute) ? { mute: saved.mute } : {}), ...(validShortcut(saved?.deafen) ? { deafen: saved.deafen } : {}) };
  } catch { return {}; }
}
export function sameShortcut(a?: TalkBinding, b?: TalkBinding): boolean {
  return !!a && !!b && a.kind === b.kind && (a.kind === 'keyboard' && b.kind === 'keyboard' ? a.code === b.code : a.kind === 'mouse' && b.kind === 'mouse' && a.button === b.button);
}
export function writeCallShortcuts(value: CallShortcutSettings): void {
  if (sameShortcut(value.mute, value.deafen)) throw new Error('Mute and deafen need different shortcuts.');
  localStorage.setItem(storageKey, JSON.stringify(value));
  window.dispatchEvent(new Event(shortcutChangeEvent));
}
