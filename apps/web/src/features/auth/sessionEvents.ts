const listeners = new Set<() => void>();
let identity: string | null = null;
let generation = 0;
export function sessionGeneration() { return generation; }
export function setSessionIdentity(userId: string | null) { if (identity !== userId) { identity = userId; generation += 1; } }
export function sessionExpired(requestGeneration = generation) {
  if (requestGeneration !== generation) return;
  setSessionIdentity(null);
  for (const listener of listeners) listener();
}
export function subscribeSessionExpiry(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
