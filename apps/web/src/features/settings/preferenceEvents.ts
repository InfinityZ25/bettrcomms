export type SyncedSettings = {
  theme: 'light' | 'dark' | 'system';
  layout: 'top' | 'side' | 'right';
  balanced: boolean;
  sounds_enabled: boolean;
  sound_volume: number;
  sounds: Partial<Record<'join' | 'leave' | 'notification' | 'ringtone' | 'share', boolean>>;
};
export type SettingsPatch = Partial<SyncedSettings>;
const listeners = new Set<(patch: SettingsPatch) => void>();
let remoteDepth = 0;

export function publishPreferenceChange(patch: SettingsPatch) {
  if (remoteDepth) return;
  for (const listener of listeners) listener(patch);
}
export function subscribePreferenceChanges(listener: (patch: SettingsPatch) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Remote changes use the regular device setters without uploading them again. */
export function applyRemotePreferences(apply: () => void) {
  remoteDepth += 1;
  try { apply(); } finally { remoteDepth -= 1; }
}
export function mergeSettings<T extends SettingsPatch>(base: T, patch: SettingsPatch): T {
  return { ...base, ...patch, ...(patch.sounds ? { sounds: { ...base.sounds, ...patch.sounds } } : {}) };
}
