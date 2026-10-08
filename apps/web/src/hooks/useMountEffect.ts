import { useEffect, type EffectCallback } from 'react';

/** A mount-scoped external subscription. Key identity-dependent children;
 * Effect Events can read committed inputs from external listeners/timers.
 * .oxlintrc.json registers this wrapper with the React Hooks rules. */
export function useMountEffect(effect: EffectCallback) {
  useEffect(effect, []);
}
