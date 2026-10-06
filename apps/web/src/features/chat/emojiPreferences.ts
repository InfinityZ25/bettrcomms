import { readStored, writeStored } from '@/lib/storage';
import { emojiTones, type EmojiTone } from './emojiCatalog';

const RECENT_LIMIT = 24;
const key = (userId: string, kind: 'recent' | 'tone') => `bc-emoji-${kind}:${userId}`;

export function readRecentEmojis(userId?: string): string[] {
  if (!userId) return [];
  try {
    const raw = JSON.parse(readStored(key(userId, 'recent')) ?? '[]') as unknown;
    return Array.isArray(raw) ? [...new Set(raw.filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 40))].slice(0, RECENT_LIMIT) : [];
  } catch { return []; }
}

export function rememberEmoji(userId: string | undefined, emoji: string) {
  if (!userId || !emoji || emoji.length > 40) return;
  writeStored(key(userId, 'recent'), JSON.stringify([emoji, ...readRecentEmojis(userId).filter((value) => value !== emoji)].slice(0, RECENT_LIMIT)));
}

export function clearRecentEmojis(userId: string | undefined) { if (userId) writeStored(key(userId, 'recent'), '[]'); }
export function readEmojiTone(userId?: string): EmojiTone {
  const value = userId ? readStored(key(userId, 'tone')) : null;
  return emojiTones.find((tone) => tone.value === value)?.value ?? 'all';
}
export function saveEmojiTone(userId: string | undefined, tone: EmojiTone) { if (userId) writeStored(key(userId, 'tone'), tone); }
