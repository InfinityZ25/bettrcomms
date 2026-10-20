import type { CharacterAppearance } from '@/api';

export type CharacterGestureKind = 'wave' | 'nod' | 'celebrate';
export type CharacterGestureEvent = {
  id: string;
  room_id: string;
  user_id: string;
  name: string;
  gesture: CharacterGestureKind;
  thread_root_id?: string;
  character: CharacterAppearance;
};

type ActiveGesture = { event: CharacterGestureEvent; expiresAt: number };
const scope = (room: string, root?: string) => root ? `${room}|${root}` : room;
const listeners = new Map<string, Set<() => void>>();
const connectionListeners = new Set<() => void>();
const active = new Map<string, ActiveGesture[]>();
const snapshots = new Map<string, CharacterGestureEvent[]>();
const seen = new Map<string, { room: string; expiresAt: number }>();
const empty: CharacterGestureEvent[] = [];
const lifetimeMs = 4000;
const maxScopes = 64;
const maxSeen = 512;
let connected = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function emit(key: string) {
  const gestures = active.get(key);
  if (gestures?.length) snapshots.set(key, gestures.map(({ event }) => event));
  else snapshots.delete(key);
  for (const listener of listeners.get(key) ?? []) listener();
}

function scheduleExpiry() {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  let next = Infinity;
  for (const gestures of active.values()) {
    for (const gesture of gestures) next = Math.min(next, gesture.expiresAt);
  }
  if (next === Infinity) return;
  timer = setTimeout(() => {
    timer = undefined;
    const now = Date.now();
    for (const [key, gestures] of active) {
      const remaining = gestures.filter(({ expiresAt }) => expiresAt > now);
      if (remaining.length === gestures.length) continue;
      if (remaining.length) active.set(key, remaining);
      else active.delete(key);
      emit(key);
    }
    scheduleExpiry();
  }, Math.max(1, next - Date.now()));
}

/** Live socket events only. These never enter message history or unread state. */
export function receiveCharacterGesture(event: CharacterGestureEvent) {
  if (!connected || !event.id || !event.room_id || !event.user_id ||
    !['wave', 'nod', 'celebrate'].includes(event.gesture)) return;
  const now = Date.now();
  for (const [id, record] of seen) if (record.expiresAt <= now) seen.delete(id);
  if (seen.has(event.id)) return;
  seen.set(event.id, { room: event.room_id, expiresAt: now + 30_000 });
  while (seen.size > maxSeen) seen.delete(seen.keys().next().value!);
  const key = scope(event.room_id, event.thread_root_id);
  const previous = active.get(key) ?? [];
  const next = previous.filter(({ event: current, expiresAt }) =>
    expiresAt > now && current.user_id !== event.user_id);
  active.delete(key);
  active.set(key, [...next, { event, expiresAt: now + lifetimeMs }].slice(-2));
  while (active.size > maxScopes) {
    const oldest = active.keys().next().value!;
    active.delete(oldest);
    emit(oldest);
  }
  emit(key);
  scheduleExpiry();
}

export function clearCharacterGestures(roomId?: string) {
  for (const [key, gestures] of active) {
    if (roomId && gestures[0]?.event.room_id !== roomId) continue;
    active.delete(key);
    emit(key);
  }
  if (roomId) {
    for (const [id, record] of seen) if (record.room === roomId) seen.delete(id);
  } else seen.clear();
  scheduleExpiry();
}

export function setCharacterGestureConnection(next: boolean) {
  if (!next) clearCharacterGestures();
  if (connected === next) return;
  connected = next;
  for (const listener of connectionListeners) listener();
}

export const characterGestureConnectionSnapshot = () => connected;
export function subscribeCharacterGestureConnection(listener: () => void) {
  connectionListeners.add(listener);
  return () => { connectionListeners.delete(listener); };
}

export const characterGesturesSnapshot = (room: string, root?: string) =>
  snapshots.get(scope(room, root)) ?? empty;

export function subscribeCharacterGestures(room: string, listener: () => void, root?: string) {
  const key = scope(room, root);
  const group = listeners.get(key) ?? new Set<() => void>();
  group.add(listener);
  listeners.set(key, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(key);
  };
}
