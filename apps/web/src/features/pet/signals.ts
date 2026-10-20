import type { CharacterAppearance } from '@/api';

/**
 * What the rest of the app tells the screen companion.
 *
 * Deliberately tiny and dependency-free: the socket, the call session and the
 * composer import this eagerly, and the companion itself loads later and only
 * when it is switched on. With nobody subscribed, emitting is a no-op and
 * nothing is queued, so a disabled companion costs one function call per event.
 */
export type PetSignal =
  | { type: 'message'; roomId: string; authorId: string; own: boolean; mention: boolean; length: number }
  | { type: 'typing'; roomId: string; userId: string; typing: boolean }
  | {
      type: 'gesture';
      id: string;
      roomId: string;
      userId: string;
      name: string;
      gesture: 'wave' | 'nod' | 'celebrate';
      character?: CharacterAppearance;
    }
  | { type: 'friend-online'; userId: string }
  | { type: 'call'; joined: boolean }
  | { type: 'call-peer'; joined: boolean }
  | { type: 'speaking'; self: boolean; active: boolean }
  | { type: 'send-failed' };

type Listener = (signal: PetSignal) => void;
const listeners = new Set<Listener>();

export function emitPetSignal(signal: PetSignal) {
  for (const listener of listeners) {
    try {
      listener(signal);
    } catch {
      /* A companion that trips over one event must not break the socket that sent it. */
    }
  }
}

export function subscribePetSignals(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
