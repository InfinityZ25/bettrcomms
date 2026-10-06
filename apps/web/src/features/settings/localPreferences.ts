import { readStored, readStoredFlag, writeStored } from '@/lib/storage';
import { publishPreferenceChange, type SyncedSettings } from './preferenceEvents';

const listeners = new Set<() => void>();
const readLayout = (): SyncedSettings['layout'] => {
  const value = readStored('bc-layout');
  return value === 'side' || value === 'right' ? value : 'top';
};
let state = { layout: readLayout(), balanced: readStoredFlag('bc-balance', 'true', false) };
export const callPreferencesSnapshot = () => state;
export function subscribeCallPreferences(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function announce() { for (const listener of listeners) listener(); }
export function setCallLayout(value: string) {
  if (value !== 'top' && value !== 'side' && value !== 'right') return;
  writeStored('bc-layout', value);
  if (state.layout !== value) { state = { ...state, layout: value }; announce(); }
  publishPreferenceChange({ layout: value });
}
export function setVoiceBalance(value: boolean) {
  writeStored('bc-balance', String(value));
  if (state.balanced !== value) { state = { ...state, balanced: value }; announce(); }
  publishPreferenceChange({ balanced: value });
}
export const THEME_KEY = 'bettercomms-ui-theme';
export function readTheme(): SyncedSettings['theme'] {
  const value = readStored(THEME_KEY);
  return value === 'light' || value === 'system' ? value : 'dark';
}
export function applyTheme(value: SyncedSettings['theme']) {
  writeStored(THEME_KEY, value);
  window.dispatchEvent(new Event('bc-theme'));
}
