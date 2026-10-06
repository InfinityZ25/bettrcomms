import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecentEmojis, readEmojiTone, readRecentEmojis, rememberEmoji, saveEmojiTone } from './emojiPreferences';
import { matchesEmojiTone } from './emojiCatalog';

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe('account scoped emoji preferences', () => {
  it('isolates recent emojis and skin tone between accounts', () => {
    rememberEmoji('first', '👩🏽‍💻');
    rememberEmoji('second', '🇲🇽');
    saveEmojiTone('first', '🏽');
    expect(readRecentEmojis('first')).toEqual(['👩🏽‍💻']);
    expect(readRecentEmojis('second')).toEqual(['🇲🇽']);
    expect(readRecentEmojis()).toEqual([]);
    expect(readEmojiTone('first')).toBe('🏽');
    expect(readEmojiTone('second')).toBe('all');
    clearRecentEmojis('first');
    expect(readRecentEmojis('first')).toEqual([]);
    expect(readRecentEmojis('second')).toEqual(['🇲🇽']);
  });

  it('keeps at most 24 unique entries in recent order', () => {
    for (let index = 0; index < 40; index++) rememberEmoji('first', `emoji${index}`);
    rememberEmoji('first', 'emoji30');
    expect(readRecentEmojis('first')).toHaveLength(24);
    expect(readRecentEmojis('first')[0]).toBe('emoji30');
    expect(readRecentEmojis('first').filter((value) => value === 'emoji30')).toHaveLength(1);
    expect(readRecentEmojis('first')).not.toContain('emoji0');
  });

  it('tolerates broken or blocked storage and rejects oversized or malformed entries', () => {
    storage.set('bc-emoji-recent:first', JSON.stringify(['👍', null, 4, 'a'.repeat(100), '👍']));
    expect(readRecentEmojis('first')).toEqual(['👍']);
    storage.set('bc-emoji-recent:first', 'broken');
    storage.set('bc-emoji-tone:first', 'unrecognized');
    expect(readRecentEmojis('first')).toEqual([]);
    expect(readEmojiTone('first')).toBe('all');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Disabled'); }, setItem: () => { throw new Error('Disabled'); } });
    expect(() => rememberEmoji('first', '👍')).not.toThrow();
    expect(readRecentEmojis('first')).toEqual([]);
  });

  it('filters whole Unicode sequences without changing their modifiers, flags or joiners', () => {
    expect(matchesEmojiTone('👩🏽‍💻', '🏽')).toBe(true);
    expect(matchesEmojiTone('👩🏿‍💻', '🏽')).toBe(false);
    expect(matchesEmojiTone('🫱🏻‍🫲🏽', '🏽')).toBe(false);
    expect(matchesEmojiTone('🫱🏻‍🫲🏽', 'all')).toBe(true);
    expect(matchesEmojiTone('👍🏽', 'none')).toBe(false);
    expect(matchesEmojiTone('🇲🇽', '🏽')).toBe(true);
    expect(matchesEmojiTone('1️⃣', 'none')).toBe(true);
  });
});
