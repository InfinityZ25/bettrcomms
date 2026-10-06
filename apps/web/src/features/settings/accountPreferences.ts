import { api, ApiRequestError } from '@/api';
import { readStored, writeStored } from '@/lib/storage';
import { setSoundEnabled, setSoundVolume, setSoundsEnabled, soundNames, soundPreferenceEnabled, soundVolume, soundsEnabled } from '@/media/sounds';
import { applyTheme, callPreferencesSnapshot, readTheme, setCallLayout, setVoiceBalance } from './localPreferences';
import { applyRemotePreferences, mergeSettings, subscribePreferenceChanges, type SettingsPatch, type SyncedSettings } from './preferenceEvents';

export type AccountPreferences = { version: number; settings: SettingsPatch };
type Snapshot = AccountPreferences & { userId?: string; enabled: boolean; ready: boolean; busy: boolean; error: string };
let state: Snapshot = { version: 0, settings: {}, enabled: false, ready: false, busy: false, error: '' };
let generation = 0;
let sessionIdentity = 0;
let pending: SettingsPatch = {};
let inFlight: SettingsPatch = {};
let timer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;
let deviceBaseline: SyncedSettings | undefined;
const listeners = new Set<() => void>();
export const accountPreferencesSnapshot = () => state;
export function subscribeAccountPreferences(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function update(patch: Partial<Snapshot>) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
function currentDeviceSettings(): SyncedSettings {
  return { theme: readTheme(), ...callPreferencesSnapshot(), sounds_enabled: soundsEnabled(), sound_volume: soundVolume(), sounds: Object.fromEntries(soundNames.map((name) => [name, soundPreferenceEnabled(name)])) };
}
/** Only the agreed portable fields enter this whitelist; devices and shortcuts never do. */
export function validAccountPreferences(value: unknown): value is AccountPreferences {
  if (!value || typeof value !== 'object') return false;
  const { version, settings } = value as AccountPreferences;
  if (!Number.isSafeInteger(version) || version < 0 || !settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const allowed = new Set(['theme', 'layout', 'balanced', 'sounds_enabled', 'sound_volume', 'sounds']);
  if (Object.keys(settings).some((key) => !allowed.has(key))) return false;
  if (settings.theme !== undefined && !['dark', 'light', 'system'].includes(settings.theme)) return false;
  if (settings.layout !== undefined && !['top', 'side', 'right'].includes(settings.layout)) return false;
  if (settings.balanced !== undefined && typeof settings.balanced !== 'boolean') return false;
  if (settings.sounds_enabled !== undefined && typeof settings.sounds_enabled !== 'boolean') return false;
  if (settings.sound_volume !== undefined && (!Number.isFinite(settings.sound_volume) || settings.sound_volume < 0 || settings.sound_volume > 1)) return false;
  if (settings.sounds !== undefined && (!settings.sounds || typeof settings.sounds !== 'object' || Array.isArray(settings.sounds) || Object.entries(settings.sounds).some(([name, enabled]) => !soundNames.includes(name as typeof soundNames[number]) || typeof enabled !== 'boolean'))) return false;
  return true;
}
function apply(settings: SettingsPatch) {
  applyRemotePreferences(() => {
    if (settings.theme !== undefined) applyTheme(settings.theme);
    if (settings.layout !== undefined) setCallLayout(settings.layout);
    if (settings.balanced !== undefined) setVoiceBalance(settings.balanced);
    if (settings.sounds_enabled !== undefined) setSoundsEnabled(settings.sounds_enabled);
    if (settings.sound_volume !== undefined) setSoundVolume(settings.sound_volume);
    for (const name of soundNames) if (settings.sounds?.[name] !== undefined) setSoundEnabled(name, settings.sounds[name]!);
  });
}
export function receiveAccountPreferences(value: unknown) {
  if (!state.userId || !state.enabled || !validAccountPreferences(value) || value.version < state.version) return;
  update({ ...value, ready: true, error: '' });
  apply(mergeSettings(mergeSettings(value.settings, inFlight), pending));
}
function scheduleWrite() {
  clearTimeout(timer);
  if (state.enabled && state.ready && Object.keys(pending).length && !request) timer = setTimeout(() => { void write(); }, 350);
}
export async function reconcileAccountPreferences() {
  if (!state.enabled || !state.userId || request) return;
  const session = generation;
  const controller = new AbortController();
  request = controller;
  update({ busy: true, error: '' });
  try {
    const result = await api<AccountPreferences>('/me/preferences', undefined, undefined, controller.signal);
    if (session !== generation || controller.signal.aborted) return;
    if (!validAccountPreferences(result)) throw new Error('The account preferences response was invalid.');
    if (result.version >= state.version) receiveAccountPreferences(result);
    // An account with no saved preferences starts from this device, only after opting in.
    if (!Object.keys(result.settings).length) pending = mergeSettings(currentDeviceSettings(), pending);
  } catch (error) {
    if (session === generation && !controller.signal.aborted) update({ error: error instanceof Error ? error.message : 'Could not sync preferences.' });
  } finally {
    if (request === controller) request = undefined;
    if (session === generation) { update({ busy: false }); scheduleWrite(); }
  }
}
async function write() {
  if (request || !state.userId || !state.enabled || !state.ready || !Object.keys(pending).length) return;
  const session = generation;
  const controller = new AbortController();
  request = controller;
  const sent = pending;
  inFlight = sent;
  pending = {};
  update({ busy: true, error: '' });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await api<AccountPreferences>('/me/preferences', { version: state.version, settings: sent }, 'PATCH', controller.signal);
        if (!validAccountPreferences(result)) throw new Error('The account preferences response was invalid.');
        if (session === generation && !controller.signal.aborted) receiveAccountPreferences(result);
        return;
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.status !== 409 || attempt === 2) throw error;
        const latest = await api<AccountPreferences>('/me/preferences', undefined, undefined, controller.signal);
        if (session !== generation || controller.signal.aborted) return;
        receiveAccountPreferences(latest);
        apply(mergeSettings(sent, pending));
      }
    }
  } catch (error) {
    if (session === generation && !controller.signal.aborted) {
      pending = mergeSettings(sent, pending);
      update({ error: error instanceof Error ? error.message : 'Could not sync preferences.' });
    }
  } finally {
    if (request === controller) request = undefined;
    if (session === generation) {
      inFlight = {};
      apply(mergeSettings(state.settings, pending));
      update({ busy: false }); if (!state.error) scheduleWrite();
    }
  }
}
export function setPreferenceSync(enabled: boolean) {
  if (!state.userId || state.enabled === enabled) return;
  generation += 1;
  clearTimeout(timer); request?.abort(); request = undefined; pending = {}; inFlight = {};
  writeStored(`bc-preference-sync:${state.userId}`, enabled ? 'on' : 'off');
  // Keep the last chosen values when disabling, rather than reverting them mid-call.
  deviceBaseline = currentDeviceSettings();
  update({ enabled, ready: false, busy: false, error: '', version: 0, settings: {} });
  if (enabled) void reconcileAccountPreferences();
}
export function startAccountPreferences(userId: string) {
  generation += 1;
  clearTimeout(timer); request?.abort(); request = undefined; pending = {}; inFlight = {};
  if (state.enabled && deviceBaseline) apply(deviceBaseline);
  deviceBaseline = currentDeviceSettings();
  update({ userId, enabled: readStored(`bc-preference-sync:${userId}`) === 'on', version: 0, settings: {}, ready: false, busy: false, error: '' });
  const identity = ++sessionIdentity;
  const unsubscribe = subscribePreferenceChanges((patch) => {
    if (!state.enabled || state.userId !== userId || identity !== sessionIdentity) return;
    pending = mergeSettings(pending, patch);
    scheduleWrite();
  });
  if (state.enabled) void reconcileAccountPreferences();
  return () => {
    unsubscribe();
    // The session identity, unlike generation, remains stable through an opt-in toggle.
    if (state.userId !== userId || identity !== sessionIdentity) return;
    generation += 1; clearTimeout(timer); request?.abort(); request = undefined; pending = {}; inFlight = {};
    if (state.enabled && deviceBaseline) apply(deviceBaseline);
    deviceBaseline = undefined;
    update({ userId: undefined, enabled: false, ready: false, busy: false, error: '', version: 0, settings: {} });
  };
}
