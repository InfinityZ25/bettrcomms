import { api, type CustomStatus } from '@/api';

export type StatusEvent = { user_id: string; status: CustomStatus; version: number };
type Entry = { status: CustomStatus; version: number };
type Snapshot = { userId?: string; entries: Readonly<Record<string, Entry>>; busy: boolean; error: string };
const empty = (): CustomStatus => ({ text: '', emoji: '', expires_at: null });
let state: Snapshot = { entries: {}, busy: false, error: '' };
let generation = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;
const requests = new Set<AbortController>();
const listeners = new Set<() => void>();
export const customStatusSnapshot = () => state;
export function subscribeCustomStatus(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function update(patch: Partial<Snapshot>) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
export function effectiveCustomStatus(status?: CustomStatus, now = Date.now()): CustomStatus {
  return status && (!status.expires_at || Date.parse(status.expires_at) > now) ? status : empty();
}
export function validCustomStatus(status: unknown): status is CustomStatus {
  if (!status || typeof status !== 'object') return false;
  const value = status as CustomStatus;
  return typeof value.text === 'string' && [...value.text].length <= 100 && typeof value.emoji === 'string' && [...value.emoji].length <= 32 && (value.expires_at == null || (typeof value.expires_at === 'string' && Number.isFinite(Date.parse(value.expires_at))));
}
function scheduleExpiry() {
  clearTimeout(expiry);
  const now = Date.now();
  const next = Object.values(state.entries).reduce((soonest, entry) => {
    const expires = entry.status.expires_at ? Date.parse(entry.status.expires_at) : Infinity;
    return expires > now ? Math.min(expires, soonest) : soonest;
  }, Infinity);
  if (Number.isFinite(next)) expiry = setTimeout(() => {
    const entries = { ...state.entries };
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.status.expires_at && Date.parse(entry.status.expires_at) <= Date.now()) entries[id] = { ...entry, status: empty() };
    }
    update({ entries }); scheduleExpiry();
  }, Math.min(2_147_483_647, Math.max(1, next - now)));
}
export function receiveCustomStatus(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const event = value as StatusEvent;
  if (typeof event.user_id !== 'string' || !event.user_id || !Number.isSafeInteger(event.version) || event.version < 0 || !validCustomStatus(event.status)) return;
  const current = state.entries[event.user_id];
  if (current && event.version < current.version) return;
  const entries = { ...state.entries, [event.user_id]: { status: effectiveCustomStatus(event.status), version: event.version } };
  let count = Object.keys(entries).length;
  for (const id of Object.keys(entries)) { if (count <= 512) break; if (id !== state.userId) { delete entries[id]; count -= 1; } }
  update({ entries }); scheduleExpiry();
}
export async function reconcileCustomStatus() {
  const userId = state.userId;
  if (!userId) return;
  const session = generation;
  const controller = new AbortController(); requests.add(controller);
  try {
    const result = await api<{ status: CustomStatus; version: number }>('/me/status', undefined, undefined, controller.signal);
    if (session === generation && !controller.signal.aborted) receiveCustomStatus({ user_id: userId, ...result });
  } catch (error) {
    if (session === generation && !controller.signal.aborted) update({ error: error instanceof Error ? error.message : 'Could not load your custom status.' });
  } finally { requests.delete(controller); }
}
export async function saveCustomStatus(status: CustomStatus) {
  const userId = state.userId;
  if (!userId || state.busy || !validCustomStatus(status)) return false;
  const session = generation;
  const controller = new AbortController(); requests.add(controller);
  update({ busy: true, error: '' });
  try {
    const result = await api<{ status: CustomStatus; version: number }>('/me/status', { status }, 'PUT', controller.signal);
    if (session !== generation || controller.signal.aborted) return false;
    if (!validCustomStatus(result.status) || !Number.isSafeInteger(result.version)) throw new Error('The custom status response was invalid.');
    receiveCustomStatus({ user_id: userId, ...result });
    return true;
  } catch (error) {
    if (session === generation && !controller.signal.aborted) update({ error: error instanceof Error ? error.message : 'Could not save your custom status.' });
    return false;
  } finally { requests.delete(controller); if (session === generation) update({ busy: false }); }
}
export function startCustomStatusSession(userId: string) {
  const session = ++generation;
  for (const controller of requests) controller.abort(); requests.clear(); clearTimeout(expiry);
  update({ userId, entries: {}, busy: false, error: '' });
  void reconcileCustomStatus();
  return () => {
    if (session !== generation) return;
    generation += 1;
    for (const controller of requests) controller.abort(); requests.clear(); clearTimeout(expiry);
    update({ userId: undefined, entries: {}, busy: false, error: '' });
  };
}
