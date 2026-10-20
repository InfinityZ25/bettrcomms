import type { CharacterAppearance } from '@/api';
import { sameCharacter, validCharacter } from './character';

type CharacterRecord = { appearance: CharacterAppearance; version: number; name?: string; avatarUrl?: string | null };
const records = new Map<string, CharacterRecord>();
const listeners = new Map<string, Set<() => void>>();
const USER_BRANCHES = ['user', 'users', 'author', 'sender', 'receiver', 'friends', 'requests', 'members', 'messages', 'root', 'mutual_friends', 'participants', 'items'] as const;
const MAX_CHARACTERS = 1024;

function trim() {
  for (const id of records.keys()) {
    if (records.size <= MAX_CHARACTERS) break;
    if (!listeners.has(id)) records.delete(id);
  }
}

export const characterSnapshot = (id: string) => records.get(id)?.appearance;
export const characterProfileSnapshot = (id: string) => records.get(id);

export function subscribeCharacter(id: string, listener: () => void) {
  const group = listeners.get(id) ?? new Set<() => void>();
  group.add(listener);
  listeners.set(id, group);
  return () => {
    group.delete(listener);
    if (!group.size) { listeners.delete(id); trim(); }
  };
}

export function receiveCharacter(id: string, appearance: unknown, version = 0, identity?: { name: string; avatar_url?: string | null }) {
  if (!id || !validCharacter(appearance)) return;
  const previous = records.get(id);
  if (previous && previous.version > version) return;
  const sameAppearance = previous && sameCharacter(previous.appearance, appearance);
  const name = identity?.name ?? previous?.name;
  const avatarUrl = identity && 'avatar_url' in identity ? identity.avatar_url : previous?.avatarUrl;
  if (sameAppearance && previous.name === name && previous.avatarUrl === avatarUrl) {
    if (version > previous.version) records.set(id, { ...previous, version });
    return;
  }
  records.delete(id);
  records.set(id, { appearance: sameAppearance ? previous.appearance : { variant: appearance.variant, hue: appearance.hue }, version, name, avatarUrl });
  for (const listener of listeners.get(id) ?? []) listener();
  trim();
}

/** Reuse bounded user snapshots already returned by the API; never fetch per avatar. */
export function observeCharacters(result: unknown) {
  const queue: { value: unknown; depth: number }[] = [{ value: result, depth: 0 }];
  for (let index = 0; index < queue.length && index < 4096; index += 1) {
    const { value, depth } = queue[index];
    if (!value || typeof value !== 'object' || depth > 6) continue;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 512)) {
        if (queue.length >= 4096) break;
        queue.push({ value: item, depth: depth + 1 });
      }
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string' && typeof record.name === 'string') {
      receiveCharacter(record.id, record.character, typeof record.profile_version === 'number' ? record.profile_version : 0, {
        name: record.name,
        ...(typeof record.avatar_url === 'string' || record.avatar_url === null ? { avatar_url: record.avatar_url } : {}),
      });
    }
    for (const key of USER_BRANCHES) {
      if (queue.length >= 4096) break;
      if (record[key]) queue.push({ value: record[key], depth: depth + 1 });
    }
  }
}

export function clearCharacters() {
  records.clear();
  for (const group of listeners.values()) for (const listener of group) listener();
}
