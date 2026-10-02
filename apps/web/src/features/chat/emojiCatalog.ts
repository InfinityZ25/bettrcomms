export type EmojiEntry = { emoji: string; name: string; category: number; search: string };
export type EmojiCatalog = { groups: string[]; entries: EmojiEntry[] };
export function normalizeEmojiSearch(query: string) { return query.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[_:]/g, ' ').trim(); }
export function findEmojis(entries: EmojiEntry[], query: string, category: number) {
  const words = normalizeEmojiSearch(query).split(/\s+/).filter(Boolean);
  return entries.filter((entry) => (category < 0 || entry.category === category) && words.every((word) => entry.search.includes(word) || entry.emoji.includes(word)));
}
export function insertEmoji(value: string, emoji: string, start: number, end: number) {
  const next = value.slice(0, start) + emoji + value.slice(end);
  return { value: next, cursor: start + emoji.length };
}
