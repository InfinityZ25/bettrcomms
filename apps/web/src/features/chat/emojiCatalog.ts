export type EmojiEntry = { emoji: string; name: string; category: number; search: string };
export type EmojiCatalog = { groups: string[]; entries: EmojiEntry[] };
export function normalizeEmojiSearch(query: string) { return query.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[_:]/g, ' ').trim(); }
export const emojiTones = [
  { value: 'all', label: 'All skin tones' },
  { value: 'none', label: 'Default skin tone' },
  { value: '🏻', label: 'Light skin tone' },
  { value: '🏼', label: 'Medium-light skin tone' },
  { value: '🏽', label: 'Medium skin tone' },
  { value: '🏾', label: 'Medium-dark skin tone' },
  { value: '🏿', label: 'Dark skin tone' },
] as const;
export type EmojiTone = typeof emojiTones[number]['value'];

export function matchesEmojiTone(emoji: string, tone: EmojiTone) {
  const modifiers = emoji.match(/[\u{1F3FB}-\u{1F3FF}]/gu) ?? [];
  return tone === 'all' || (tone === 'none' ? !modifiers.length : !modifiers.length || modifiers.every((modifier) => modifier === tone));
}

export function findEmojis(entries: EmojiEntry[], query: string, category: number, tone: EmojiTone = 'all') {
  const words = normalizeEmojiSearch(query).split(/\s+/).filter(Boolean);
  return entries.filter((entry) => (category < 0 || entry.category === category) && matchesEmojiTone(entry.emoji, tone) && words.every((word) => entry.search.includes(word) || entry.emoji.includes(word)));
}
export function insertEmoji(value: string, emoji: string, start: number, end: number) {
  const next = value.slice(0, start) + emoji + value.slice(end);
  return { value: next, cursor: start + emoji.length };
}
