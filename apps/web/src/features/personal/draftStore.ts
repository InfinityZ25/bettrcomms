import { ApiRequestError } from '@/api';
import {
  api,
  subscribePersonalEvents,
  type DraftSyncSetting,
  type TextDraft,
} from './api';

export interface DraftEntry {
  roomId: string;
  root?: string;
  body: string;
  replyToId?: string;
  version: number;
  ready: boolean;
  dirty: boolean;
  writing: boolean;
  focused: boolean;
  conflict?: TextDraft;
  remote?: TextDraft;
  error: string;
  mutation?: { id: string; body: string; replyToId?: string; version: number };
}
type DraftState = {
  userId?: string;
  enabled: boolean;
  settingVersion: number;
  ready: boolean;
  busy: boolean;
  error: string;
  entries: Record<string, DraftEntry>;
};
const empty: DraftState = {
  enabled: true,
  settingVersion: 0,
  ready: false,
  busy: false,
  error: '',
  entries: {},
};
let state = empty;
let generation = 0;
let lifetime: AbortController | undefined;
let refreshing: Promise<void> | undefined;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const writes = new Map<string, Promise<void>>();
const writeControllers = new Map<string, AbortController>();
const reads = new Map<string, Promise<void>>();
export const draftScope = (room: string, root?: string) =>
  `${room}${root ? `:thread:${root}` : ''}`;
export function draftReplyToId(
  room: string,
  hydratedReplyId?: string,
  root?: string,
) {
  const entry = state.entries[draftScope(room, root)];
  return entry ? entry.replyToId : hydratedReplyId;
}
const localKey = (user: string, scope: string) =>
  `bettercomms:text-draft:${user}:${scope}`;
const boundedText = (body: string) => [...body].slice(0, 4000).join('');
export const draftsSnapshot = () => state;
export function subscribeDrafts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function update(patch: Partial<DraftState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
function persist(scope: string, value: DraftEntry) {
  if (!state.userId) return;
  try {
    localStorage.setItem(
      localKey(state.userId, scope),
      JSON.stringify({
        body: value.body,
        replyToId: value.replyToId,
        version: value.version,
        dirty: value.dirty,
        remote: value.remote,
        conflict: value.conflict,
        mutation: value.mutation,
      }),
    );
  } catch {
    /* Disabled local storage must not block composing. */
  }
}
function put(scope: string, patch: Partial<DraftEntry>) {
  const previous = state.entries[scope];
  if (!previous) return;
  const entry = { ...previous, ...patch };
  persist(scope, entry);
  update({ entries: { ...state.entries, [scope]: entry } });
}
function validRemote(value: unknown): value is TextDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as TextDraft;
  return (
    typeof draft.room_id === 'string' &&
    typeof draft.body === 'string' &&
    [...draft.body].length <= 4000 &&
    Number.isSafeInteger(draft.version) &&
    draft.version >= 0 &&
    (draft.updated_at === undefined
      ? draft.version === 0 && draft.body === ''
      : typeof draft.updated_at === 'string') &&
    (draft.thread_root_id === undefined ||
      typeof draft.thread_root_id === 'string') &&
    (draft.reply_to_id === undefined || typeof draft.reply_to_id === 'string')
  );
}
function sameText(body: string, reply: string | undefined, remote: TextDraft) {
  return body === remote.body && (reply || '') === (remote.reply_to_id || '');
}
function emptyEntry(room: string, root?: string): DraftEntry {
  return {
    roomId: room,
    root,
    body: '',
    version: 0,
    ready: false,
    dirty: false,
    writing: false,
    focused: false,
    error: '',
  };
}
function ensure(room: string, root?: string) {
  const scope = draftScope(room, root);
  if (state.entries[scope]) return scope;
  let entry = emptyEntry(room, root);
  if (state.userId) {
    try {
      const value = JSON.parse(
        localStorage.getItem(localKey(state.userId, scope)) ?? 'null',
      ) as Partial<DraftEntry> | null;
      if (value && typeof value.body === 'string')
        entry = {
          ...entry,
          body: boundedText(value.body),
          replyToId:
            typeof value.replyToId === 'string' ? value.replyToId : undefined,
          version: Number.isSafeInteger(value.version) ? value.version! : 0,
          dirty: value.dirty === true,
          remote: validRemote(value.remote) ? value.remote : undefined,
          conflict: validRemote(value.conflict) ? value.conflict : undefined,
          mutation:
            value.mutation &&
            typeof value.mutation.id === 'string' &&
            typeof value.mutation.body === 'string' &&
            Number.isSafeInteger(value.mutation.version)
              ? {
                  id: value.mutation.id,
                  body: boundedText(value.mutation.body),
                  replyToId: value.mutation.replyToId,
                  version: value.mutation.version,
                }
              : undefined,
        };
      else {
        const legacy = JSON.parse(
          localStorage.getItem(`bettercomms:draft:${state.userId}:${scope}`) ??
            '{}',
        ) as { body?: unknown };
        if (typeof legacy.body === 'string')
          entry = {
            ...entry,
            body: boundedText(legacy.body),
            dirty: Boolean(legacy.body),
          };
      }
    } catch {
      /* A corrupt local record is treated as an empty draft. */
    }
  }
  update({ entries: { ...state.entries, [scope]: entry } });
  return scope;
}
export function receiveTextDraft(remote: TextDraft) {
  if (!state.userId || !state.enabled || !validRemote(remote)) return;
  const scope = ensure(remote.room_id, remote.thread_root_id);
  const local = state.entries[scope];
  if (remote.version < local.version) return;
  if (
    local.ready &&
    remote.version === local.version &&
    local.remote &&
    sameText(local.remote.body, local.remote.reply_to_id, remote)
  ) {
    put(scope, { remote, error: '' });
    schedule(scope);
    return;
  }
  const ownMutation = Boolean(
    local.mutation && local.mutation.id === remote.mutation_id,
  );
  if (sameText(local.body, local.replyToId, remote)) {
    put(scope, {
      remote,
      version: remote.version,
      ready: true,
      dirty: false,
      conflict: undefined,
      mutation: undefined,
      error: '',
    });
  } else if (ownMutation) {
    put(scope, {
      remote,
      version: remote.version,
      ready: true,
      mutation: undefined,
      error: '',
    });
  } else if (!local.ready && !remote.version && local.dirty && !remote.body) {
    // Legacy device text is imported only after the server confirms absence.
    put(scope, { remote, version: 0, ready: true, error: '' });
  } else if (
    local.dirty ||
    local.conflict ||
    (local.focused && remote.body && remote.version > local.version)
  ) {
    put(scope, {
      remote,
      version: remote.version,
      ready: true,
      conflict: remote,
      error: '',
    });
  } else {
    put(scope, {
      body: remote.body,
      replyToId: remote.reply_to_id,
      remote,
      version: remote.version,
      ready: true,
      dirty: false,
      conflict: undefined,
      mutation: undefined,
      error: '',
    });
  }
  schedule(scope);
}
function route(entry: DraftEntry) {
  return `/rooms/${entry.roomId}/drafts${entry.root ? `?thread_root_id=${encodeURIComponent(entry.root)}` : ''}`;
}
export async function loadTextDraft(room: string, root?: string) {
  if (!state.userId || !lifetime) return;
  const scope = ensure(room, root);
  if (!state.enabled) {
    put(scope, { ready: true });
    return;
  }
  if (reads.has(scope)) return reads.get(scope);
  const session = generation;
  const signal = lifetime.signal;
  const task = (async () => {
    try {
      const result = await api<TextDraft>(
        route(state.entries[scope]),
        undefined,
        undefined,
        signal,
      );
      if (session === generation && !signal.aborted) receiveTextDraft(result);
    } catch (error) {
      if (session === generation && !signal.aborted)
        put(scope, {
          error:
            error instanceof Error
              ? error.message
              : 'Could not load synced draft.',
        });
    }
  })();
  reads.set(scope, task);
  try {
    await task;
  } finally {
    if (reads.get(scope) === task) reads.delete(scope);
  }
}
function schedule(scope: string) {
  const previous = timers.get(scope);
  if (previous) clearTimeout(previous);
  timers.delete(scope);
  const entry = state.entries[scope];
  if (
    !state.enabled ||
    !state.ready ||
    !entry?.ready ||
    !entry.dirty ||
    entry.conflict ||
    entry.error ||
    writes.has(scope)
  )
    return;
  timers.set(
    scope,
    setTimeout(() => {
      timers.delete(scope);
      void write(scope);
    }, 500),
  );
}
async function write(scope: string) {
  if (!state.userId || !state.enabled || !lifetime || writes.has(scope))
    return writes.get(scope);
  const local = state.entries[scope];
  if (!local?.ready || !local.dirty || local.conflict) return;
  const session = generation;
  const globalSignal = lifetime.signal;
  const controller = new AbortController();
  const abortWrite = () => controller.abort();
  globalSignal.addEventListener('abort', abortWrite, { once: true });
  writeControllers.set(scope, controller);
  const signal = controller.signal;
  const mutation = local.mutation ?? {
    id: crypto.randomUUID(),
    body: local.body,
    replyToId: local.replyToId,
    version: local.version,
  };
  put(scope, { mutation, writing: true, error: '' });
  const task = (async () => {
    try {
      const result = await api<TextDraft>(
        route(local),
        {
          body: mutation.body,
          reply_to_id: mutation.replyToId,
          expected_version: mutation.version,
          mutation_id: mutation.id,
        },
        'PUT',
        signal,
      );
      if (session === generation && !signal.aborted) receiveTextDraft(result);
    } catch (error) {
      if (session !== generation || signal.aborted) return;
      if (error instanceof ApiRequestError && error.status === 409) {
        put(scope, { mutation: undefined });
        await loadTextDraft(local.roomId, local.root);
      } else
        put(scope, {
          error:
            error instanceof Error
              ? error.message
              : 'Draft stays on this device until sync reconnects.',
        });
    }
  })();
  writes.set(scope, task);
  try {
    await task;
  } finally {
    globalSignal.removeEventListener('abort', abortWrite);
    if (writeControllers.get(scope) === controller)
      writeControllers.delete(scope);
    if (writes.get(scope) === task) writes.delete(scope);
    if (session === generation && !signal.aborted) {
      put(scope, { writing: false });
      schedule(scope);
    }
  }
}
export function editTextDraft(
  room: string,
  body: string,
  replyToId?: string,
  root?: string,
) {
  if (!state.userId) return;
  const scope = ensure(room, root);
  const entry = state.entries[scope];
  if (entry.body === body && (entry.replyToId || '') === (replyToId || ''))
    return;
  put(scope, { body: boundedText(body), replyToId, dirty: true, error: '' });
  schedule(scope);
}
export function focusTextDraft(room: string, focused: boolean, root?: string) {
  if (!state.userId) return;
  const scope = ensure(room, root);
  put(scope, { focused });
}
export function resolveDraftConflict(
  room: string,
  choice: 'local' | 'remote',
  root?: string,
) {
  const scope = draftScope(room, root);
  const entry = state.entries[scope];
  if (!entry?.conflict) return;
  const remote = entry.conflict;
  put(
    scope,
    choice === 'remote'
      ? {
          body: remote.body,
          replyToId: remote.reply_to_id,
          dirty: false,
          conflict: undefined,
          mutation: undefined,
          error: '',
        }
      : { dirty: true, conflict: undefined, mutation: undefined, error: '' },
  );
  schedule(scope);
}
export async function submittedDraft(room: string, root?: string) {
  const scope = ensure(room, root);
  const timer = timers.get(scope);
  if (timer) clearTimeout(timer);
  timers.delete(scope);
  await loadTextDraft(room, root);
  if (state.entries[scope]?.conflict || !state.enabled) return undefined;
  await writes.get(scope);
  await write(scope);
  const entry = state.entries[scope];
  if (!entry || entry.dirty || entry.conflict || entry.error) return undefined;
  return {
    draft_version: entry.version,
    draft_mutation_id: crypto.randomUUID(),
  };
}
export function sentTextDraft(
  room: string,
  body: string,
  reply: string | undefined,
  submittedVersion: number | undefined,
  root?: string,
) {
  const scope = draftScope(room, root);
  const entry = state.entries[scope];
  if (
    !entry ||
    entry.body !== body ||
    (entry.replyToId || '') !== (reply || '')
  )
    return;
  // Keep a newer remote fork; sending local conflict text must not erase it.
  if (
    entry.conflict ||
    (submittedVersion !== undefined && entry.version > submittedVersion)
  )
    return;
  put(scope, {
    body: '',
    replyToId: undefined,
    dirty: false,
    mutation: undefined,
    focused: false,
  });
  if (state.enabled) void loadTextDraft(room, root);
}
export async function refreshDrafts() {
  if (!state.userId || !lifetime) return;
  if (refreshing) return refreshing;
  const session = generation;
  const signal = lifetime.signal;
  const task = (async () => {
    try {
      const setting = await api<DraftSyncSetting>(
        '/me/draft-sync',
        undefined,
        undefined,
        signal,
      );
      if (session !== generation || signal.aborted) return;
      update({
        enabled: setting.enabled,
        settingVersion: setting.version,
        ready: true,
        error: '',
      });
      if (!setting.enabled) {
        stopDraftWrites();
        return;
      }
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const result = await api<{ drafts: TextDraft[]; next_cursor?: string }>(
          `/me/drafts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          undefined,
          undefined,
          signal,
        );
        if (session !== generation || signal.aborted) return;
        for (const draft of result.drafts) receiveTextDraft(draft);
        cursor = result.next_cursor ?? '';
        if (!cursor) break;
      }
      // Fetch absence/tombstone for every locally owned scope before import.
      for (const entry of Object.values(state.entries))
        if (!entry.ready || entry.dirty || entry.conflict || entry.error)
          await loadTextDraft(entry.roomId, entry.root);
    } catch (error) {
      if (session === generation && !signal.aborted)
        update({
          error:
            error instanceof Error
              ? error.message
              : 'Drafts stay on this device until sync reconnects.',
        });
    }
  })();
  refreshing = task;
  try {
    await task;
  } finally {
    if (refreshing === task) refreshing = undefined;
  }
}
export async function setDraftSync(enabled: boolean) {
  if (!state.userId || !lifetime || state.busy) return;
  const session = generation;
  const signal = lifetime.signal;
  update({ busy: true, error: '' });
  try {
    const setting = await api<DraftSyncSetting>(
      '/me/draft-sync',
      { enabled, expected_version: state.settingVersion },
      'PUT',
      signal,
    );
    if (session !== generation || signal.aborted) return;
    update({ enabled: setting.enabled, settingVersion: setting.version });
    if (!setting.enabled) stopDraftWrites();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (enabled) await refreshDrafts();
  } catch (error) {
    if (session === generation && !signal.aborted)
      update({
        error:
          error instanceof Error
            ? error.message
            : 'Could not change draft sync.',
      });
    if (error instanceof ApiRequestError && error.status === 409)
      await refreshDrafts();
  } finally {
    if (session === generation && !signal.aborted) update({ busy: false });
  }
}
function stopDraftWrites() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  for (const controller of writeControllers.values()) controller.abort();
  writeControllers.clear();
  writes.clear();
  update({
    entries: Object.fromEntries(
      Object.entries(state.entries).map(([scope, entry]) => [
        scope,
        { ...entry, writing: false },
      ]),
    ),
  });
}
export function startDraftSession(userId: string) {
  lifetime?.abort();
  writeControllers.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  writes.clear();
  reads.clear();
  refreshing = undefined;
  const session = ++generation;
  const controller = new AbortController();
  lifetime = controller;
  update({ ...empty, userId });
  try {
    const prefixes = [
      `bettercomms:draft:${userId}:`,
      `bettercomms:text-draft:${userId}:`,
    ];
    const scopes = new Set<string>();
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      const prefix = prefixes.find((candidate) => key?.startsWith(candidate));
      if (key && prefix) scopes.add(key.slice(prefix.length));
    }
    for (const scope of scopes) {
      const [room, root] = scope.split(':thread:');
      if (room) ensure(room, root);
    }
  } catch {
    /* Storage may be disabled. */
  }
  const off = subscribePersonalEvents((type) => {
    if (type === 'personal.drafts.changed' || type === 'draft-sync.changed')
      void refreshDrafts();
  });
  const focus = () => {
    void refreshDrafts();
  };
  window.addEventListener('focus', focus);
  window.addEventListener('online', focus);
  void refreshDrafts();
  return () => {
    off();
    window.removeEventListener('focus', focus);
    window.removeEventListener('online', focus);
    if (session !== generation) return;
    generation++;
    controller.abort();
    lifetime = undefined;
    refreshing = undefined;
    writeControllers.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    writes.clear();
    reads.clear();
    update(empty);
  };
}
