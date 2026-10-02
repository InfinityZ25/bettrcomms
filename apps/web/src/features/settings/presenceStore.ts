import { api, type User } from '@/api';
import { setAccountDoNotDisturb } from '@/features/chat/notificationSettings';

export type AccountStatus = NonNullable<User['presence_status']>;
export type ContactStatus = Exclude<AccountStatus, 'invisible'> | 'offline';
export const presenceLabels: Record<AccountStatus | 'offline', string> = {
  online: 'Online', idle: 'Away', dnd: 'Do not disturb', invisible: 'Invisible', offline: 'Offline',
};
export function isAccountStatus(value: unknown): value is AccountStatus {
  return value === 'online' || value === 'idle' || value === 'dnd' || value === 'invisible';
}
export function contactStatus(value: unknown, online: boolean): ContactStatus {
  if (value === 'invisible') return 'offline';
  return online && (value === 'online' || value === 'idle' || value === 'dnd') ? value : online ? 'online' : 'offline';
}
type PresenceSnapshot = { userId?: string; status: AccountStatus; busy: boolean; error: string };
const listeners = new Set<() => void>();
let state: PresenceSnapshot = { status: 'online', busy: false, error: '' };
let generation = 0;
let eventRevision = 0;
export const ownPresenceSnapshot = () => state;
export function subscribeOwnPresence(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function update(patch: Partial<PresenceSnapshot>) {
  state = { ...state, ...patch };
  if (state.userId) setAccountDoNotDisturb(state.userId, state.status === 'dnd');
  for (const listener of listeners) listener();
}
export function startPresenceSession(user: string, status: AccountStatus = 'online') {
  const session = ++generation;
  eventRevision = 0;
  update({ userId: user, status, busy: false, error: '' });
  return () => {
    if (session !== generation) return;
    generation += 1;
    setAccountDoNotDisturb(user, false);
    update({ userId: undefined, status: 'online', busy: false, error: '' });
  };
}
export function receiveOwnPresence(user: string, status: unknown) {
  if (state.userId !== user || !isAccountStatus(status)) return;
  eventRevision += 1;
  update({ status, error: '' });
}
export async function changeOwnPresence(user: string, status: AccountStatus) {
  if (state.userId !== user || state.busy || !isAccountStatus(status)) return;
  const session = generation;
  const revision = eventRevision;
  update({ busy: true, error: '' });
  try {
    const result = await api<{ status: AccountStatus }>('/me/presence', { status }, 'PUT');
    if (session !== generation || state.userId !== user) return;
    // A newer event from another device wins over this request's older reply.
    if (revision === eventRevision && isAccountStatus(result.status)) update({ status: result.status });
  } catch (error) {
    if (session === generation) update({ error: error instanceof Error ? error.message : 'Could not change your status.' });
  } finally {
    if (session === generation) update({ busy: false });
  }
}
