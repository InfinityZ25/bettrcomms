import { api, type Room } from '@/api';
import { isConversationRoom } from '@/features/shell/sections';

export type ConversationPreference = { favorite: boolean; archived: boolean; version: number };
type PreferenceState = {
  userId?: string;
  preferences: Record<string, ConversationPreference>;
  ready: boolean;
  error: string;
  busy: Record<string, boolean>;
};
const empty: PreferenceState = { preferences: {}, ready: false, error: '', busy: {} };
const listeners = new Set<() => void>();
let state = empty;
let generation = 0;
let lifetime: AbortController | undefined;
let read: AbortController | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const writes = new Map<string, Promise<void>>();

export const conversationPreferencesSnapshot = () => state;
export function subscribeConversationPreferences(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function update(patch: Partial<PreferenceState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
function valid(value: unknown): value is ConversationPreference {
  if (!value || typeof value !== 'object') return false;
  const item = value as ConversationPreference;
  return typeof item.favorite === 'boolean' && typeof item.archived === 'boolean'
    && Number.isSafeInteger(item.version) && item.version > 0;
}
export function receiveConversationPreference(payload: unknown) {
  if (!state.userId || !payload || typeof payload !== 'object') return;
  const value = payload as ConversationPreference & { room_id: string };
  if (typeof value.room_id !== 'string' || !valid(value)) return;
  if ((state.preferences[value.room_id]?.version ?? 0) >= value.version) return;
  update({ preferences: { ...state.preferences, [value.room_id]: {
    favorite: value.favorite, archived: value.archived, version: value.version,
  } } });
}
export async function refreshConversationPreferences() {
  const userId = state.userId;
  if (!userId) return;
  const session = generation;
  const baseline = state.preferences;
  read?.abort();
  const request = new AbortController();
  read = request;
  try {
    const result = await api<{ preferences: Record<string, ConversationPreference> }>(
      '/me/conversations', undefined, undefined, request.signal,
    );
    if (request.signal.aborted || session !== generation) return;
    const next: Record<string, ConversationPreference> = {};
    for (const [id, value] of Object.entries(result.preferences ?? {})) {
      if (!valid(value)) continue;
      const known = state.preferences[id];
      next[id] = known && known.version > value.version ? known : value;
    }
    // Preserve only writes received since the request started. Missing older
    // rows belong to memberships that were revoked and must leave the cache.
    for (const [id, value] of Object.entries(state.preferences)) {
      if ((baseline[id]?.version ?? 0) < value.version) next[id] ??= value;
    }
    update({ preferences: next, ready: true, error: '' });
  } catch (error) {
    if (!request.signal.aborted && session === generation)
      update({ error: error instanceof Error ? error.message : 'Could not load conversation preferences.' });
  } finally {
    if (read === request) read = undefined;
  }
}
export function reconcileConversationPreferences() {
  if (!state.userId || refreshTimer !== undefined) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshConversationPreferences();
  }, 150);
}
export function startConversationPreferencesSession(userId: string) {
  lifetime?.abort();
  read?.abort();
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  refreshTimer = undefined;
  const session = ++generation;
  const abort = new AbortController();
  lifetime = abort;
  writes.clear();
  update({ ...empty, userId });
  void refreshConversationPreferences();
  return () => {
    abort.abort();
    if (session !== generation) return;
    generation++;
    read?.abort();
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    lifetime = read = undefined;
    writes.clear();
    update(empty);
  };
}
export function setConversationPreference(room: Room, patch: Partial<Pick<ConversationPreference, 'favorite' | 'archived'>>) {
  if (!state.userId || !lifetime || lifetime.signal.aborted) return Promise.reject(new Error('Sign in required.'));
  if (patch.archived && !isConversationRoom(room.kind)) return Promise.reject(new Error('Only private conversations can be archived.'));
  const session = generation;
  const signal = lifetime.signal;
  update({ busy: { ...state.busy, [room.id]: true } });
  const next = (writes.get(room.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (signal.aborted || session !== generation) return;
    const response = await api<ConversationPreference & { room_id: string }>(
      `/rooms/${room.id}/preferences`, patch, 'PUT', signal,
    );
    if (signal.aborted || session !== generation) return;
    receiveConversationPreference(response);
  });
  writes.set(room.id, next);
  void next.finally(() => {
    if (session !== generation || writes.get(room.id) !== next) return;
    writes.delete(room.id);
    const busy = { ...state.busy };
    delete busy[room.id];
    update({ busy });
  }).catch(() => {});
  return next;
}
export function sortConversations(rooms: Room[], preferences: Record<string, ConversationPreference>, activity: Record<string, string> = {}) {
  const time = (room: Room) => Math.max(Date.parse(activity[room.id] ?? '') || 0, Date.parse(room.activity_at ?? room.created_at) || 0);
  return [...rooms].sort((a, b) => Number(Boolean(preferences[b.id]?.favorite)) - Number(Boolean(preferences[a.id]?.favorite))
    || time(b) - time(a) || a.id.localeCompare(b.id));
}
