import { describe, expect, it } from 'vitest';
import raw from './emoji/catalog.json';
import { findEmojis, insertEmoji, normalizeEmojiSearch } from './emojiCatalog';

const entries = raw.entries.map(([emoji, name, category]) => ({ emoji: String(emoji), name: String(name), category: Number(category), search: normalizeEmojiSearch(String(name)) }));
describe('Unicode emoji catalog', () => {
  it('contains qualified compound emojis, flags, skin tones and keycaps', () => {
    expect(entries).toHaveLength(3944);
    for (const emoji of ['👍🏽', '👩‍💻', '🇲🇽', '1️⃣']) expect(entries.some((entry) => entry.emoji === emoji)).toBe(true);
  });
  it('searches names and categories without rendering the whole result set', () => {
    expect(findEmojis(entries, ':thumbs_up:', -1).some((entry) => entry.emoji === '👍🏽')).toBe(true);
    expect(findEmojis(entries, 'Mexico', -1).map((entry) => entry.emoji)).toContain('🇲🇽');
    const category = entries.find((entry) => entry.emoji === '🇲🇽')!.category;
    expect(findEmojis(entries, 'Mexico', category + 1)).toHaveLength(0);
  });
  it('inserts at the UTF-16 textarea selection and restores its caret', () => {
    expect(insertEmoji('hello world', '👩‍💻', 6, 11)).toEqual({ value: 'hello 👩‍💻', cursor: 11 });
  });
});
