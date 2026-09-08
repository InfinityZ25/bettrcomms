import { useEffect, type EffectCallback } from 'react';

/** A mount-scoped external subscription; dynamic inputs belong in a keyed child. */
export function useMountEffect(effect: EffectCallback) {
  useEffect(effect, []);
}
