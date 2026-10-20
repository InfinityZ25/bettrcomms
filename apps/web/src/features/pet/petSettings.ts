import { useSyncExternalStore } from 'react';
import { readStored, readStoredOption, writeStored } from '@/lib/storage';

/**
 * Device-local companion preferences.
 *
 * Whether a creature walks around this screen is a question about this screen,
 * so it is not synced to the account: a desktop can keep it while a phone
 * turns it off. Other tabs follow through the storage event.
 */
export const PET_SIZES = ['small', 'medium', 'large'] as const;
export type PetSize = (typeof PET_SIZES)[number];
export const PET_SIZE_PX: Record<PetSize, number> = { small: 54, medium: 72, large: 94 };
export const PET_SIZE_LABELS: Record<PetSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

type PetSettings = { enabled: boolean; size: PetSize };
const ENABLED_KEY = 'bc-pet';
const SIZE_KEY = 'bc-pet-size';
const listeners = new Set<() => void>();
let snapshot: PetSettings = read();

function read(): PetSettings {
  return {
    enabled: readStored(ENABLED_KEY) !== 'off',
    size: readStoredOption(SIZE_KEY, PET_SIZES, 'medium'),
  };
}

function publish(next: PetSettings) {
  if (next.enabled === snapshot.enabled && next.size === snapshot.size) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === ENABLED_KEY || event.key === SIZE_KEY) publish(read());
}

export const petSettingsSnapshot = () => snapshot;
export function subscribePetSettings(listener: () => void) {
  if (!listeners.size && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function setPetEnabled(enabled: boolean) {
  writeStored(ENABLED_KEY, enabled ? 'on' : 'off');
  publish({ ...snapshot, enabled });
}

export function setPetSize(size: PetSize) {
  writeStored(SIZE_KEY, size);
  publish({ ...snapshot, size });
}

export function usePetSettings() {
  return useSyncExternalStore(subscribePetSettings, petSettingsSnapshot, petSettingsSnapshot);
}
