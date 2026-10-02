import type { User } from '@/api';

let profiles: Readonly<Record<string, User>> = {};
const listeners = new Set<() => void>();
const revisions = new Map<string, number>();

export const profileSnapshot = () => profiles;
export const profileRevision = (id: string) => revisions.get(id) ?? 0;
export function subscribeProfiles(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Events and successful edits share one cache, so late HTTP reads cannot undo them. */
export function receiveProfile(user: User) {
  if (!user?.id || typeof user.name !== 'string') return;
  const current = profiles[user.id];
  if (current && (current.profile_version ?? 0) > (user.profile_version ?? 0)) return current;
  const next = { ...profiles, [user.id]: user };
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - 512))) delete next[id];
  profiles = next;
  revisions.set(user.id, profileRevision(user.id) + 1);
  for (const id of revisions.keys()) if (!(id in next)) revisions.delete(id);
  for (const listener of listeners) listener();
  return user;
}

export function reconcileProfile(user: User, startedAt: number) {
  const current = profiles[user.id];
  if (current && profileRevision(user.id) !== startedAt && (current.profile_version ?? 0) >= (user.profile_version ?? 0)) return current;
  return receiveProfile(user) ?? user;
}

export function clearProfiles() {
  profiles = {};
  revisions.clear();
  for (const listener of listeners) listener();
}
