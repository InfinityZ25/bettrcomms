import { useSyncExternalStore } from 'react';
import type { BlobatarOptions } from 'blobatar';

/**
 * Whose face is whose.
 *
 * A blobatar is a pure function of the string it is drawn from, and the string
 * is the account id wherever one is known: a display name is something people
 * change, and a face that changes with it stops being theirs.
 *
 * Nobody edits their own. The creature people tune is the app's mascot, which
 * is one character and lives in components/mascot.tsx; a face here stands for
 * a person and is theirs by derivation rather than by choice.
 */
export type BlobatarIdentity = Pick<BlobatarOptions, 'traits' | 'hue'> & {
  /** The seed. Everything about the creature that is not overridden. */
  name: string;
};

/**
 * A hue for a key, spread across the whole wheel.
 *
 * Left to itself the generator picks colour from the same hash that picks the
 * silhouette, and in a small group the results clustered: a row of faces that
 * were all some variety of red told you nothing apart. Driving hue from its own
 * hash separates it from every other trait, so two people with similar names
 * still get different colours, and the same person gets the same one forever.
 */
export function hueFor(key: string): number {
  // FNV-1a, for no reason beyond being short, stable and well spread.
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 3600) / 10;
}

/** The face for a person, by account id where there is one and by name where there is not. */
export function blobatarFor(key: string): BlobatarIdentity {
  return { name: key, hue: hueFor(key) };
}

/**
 * Which of the two faces is the big one, for the account viewing this client.
 *
 * A personal display choice, so it lives on the device rather than on the
 * account: it changes what you see, everywhere your own avatar appears. Making
 * it change what *other people* see would mean a column on the user record,
 * which this does not have yet.
 */
export type FacePreference = 'photo' | 'face';
const FACE_KEY = 'bc-own-face';

let preference: FacePreference = read();
const listeners = new Set<() => void>();

function read(): FacePreference {
  try {
    return localStorage.getItem(FACE_KEY) === 'face' ? 'face' : 'photo';
  } catch {
    // A browser that refuses storage still gets a working avatar.
    return 'photo';
  }
}

export function ownFace(): FacePreference {
  return preference;
}

export function setOwnFace(next: FacePreference) {
  if (preference === next) return;
  preference = next;
  try {
    localStorage.setItem(FACE_KEY, next);
  } catch {
    // Not persisting is survivable; not applying it would not be.
  }
  for (const listener of listeners) listener();
}

/** Re-renders when the preference changes. */
export function useOwnFace(): FacePreference {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => preference,
    () => 'photo' as FacePreference,
  );
}
