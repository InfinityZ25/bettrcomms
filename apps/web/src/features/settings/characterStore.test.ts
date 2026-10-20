import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  characterSnapshot,
  characterProfileSnapshot,
  clearCharacters,
  observeCharacters,
  receiveCharacter,
  subscribeCharacter,
} from './characterStore';

afterEach(clearCharacters);
const user = (id: string, variant = 1, version = 2) => ({
  id, name: id, character: { variant, hue: null }, profile_version: version,
});

describe('shared character snapshots', () => {
  it('hydrates existing API user branches without interpreting message content', () => {
    observeCharacters({
      user: user('self'),
      friends: [user('friend')],
      requests: [{ sender: user('sender'), receiver: user('receiver') }],
      members: [{ user: user('member') }],
      messages: [{ id: 'message', author: user('author'), body: { author: user('content') } }],
      root: { author: user('root-author') },
      mutual_friends: [user('mutual')],
      participants: [user('participant')],
      items: [{ author: user('item-author') }],
      unrecognized: { user: user('unrecognized') },
    });
    for (const id of ['self', 'friend', 'sender', 'receiver', 'member', 'author', 'root-author', 'mutual', 'participant', 'item-author']) {
      expect(characterSnapshot(id), id).toEqual({ variant: 1, hue: null });
    }
    expect(characterSnapshot('content')).toBeUndefined();
    expect(characterSnapshot('unrecognized')).toBeUndefined();
  });

  it('keeps a newer profile event when an older history or member request finishes later', () => {
    receiveCharacter('person', { variant: 4, hue: 210 }, 8);
    observeCharacters({ messages: [{ author: user('person', 1, 7) }] });
    observeCharacters({ members: [{ user: user('person', 2, 6) }] });
    expect(characterSnapshot('person')).toEqual({ variant: 4, hue: 210 });
    // A gesture/event without a profile version cannot downgrade a known profile.
    receiveCharacter('person', { variant: 3, hue: null });
    expect(characterSnapshot('person')).toEqual({ variant: 4, hue: 210 });
  });

  it('keeps name and photo synchronized with the same authoritative profile version', () => {
    observeCharacters({ user: { ...user('person', 3, 5), name: 'Current name', avatar_url: '/avatars/current' } });
    observeCharacters({ messages: [{ author: { ...user('person', 1, 4), name: 'Old name', avatar_url: '/avatars/old' } }] });
    expect(characterProfileSnapshot('person')).toMatchObject({
      name: 'Current name', avatarUrl: '/avatars/current', appearance: { variant: 3, hue: null },
    });
    const first = characterSnapshot('person');
    observeCharacters({ user: { ...user('person', 3, 6), name: 'New name', avatar_url: null } });
    expect(characterProfileSnapshot('person')).toMatchObject({ name: 'New name', avatarUrl: null });
    expect(characterSnapshot('person')).toBe(first);
  });

  it('remembers newer versions even when appearance stayed the same without redrawing it', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCharacter('person', listener);
    receiveCharacter('person', { variant: 1, hue: 25 }, 1);
    const first = characterSnapshot('person');
    receiveCharacter('person', { variant: 1, hue: 25 }, 5);
    expect(characterSnapshot('person')).toBe(first);
    receiveCharacter('person', { variant: 2, hue: 25 }, 4);
    expect(characterSnapshot('person')).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('copies accepted appearances and rejects invalid updates without losing identity', () => {
    const source = { variant: 2, hue: 150 };
    receiveCharacter('person', source, 1);
    source.variant = 5;
    expect(characterSnapshot('person')).toEqual({ variant: 2, hue: 150 });
    receiveCharacter('person', { variant: 500, hue: null }, 9);
    receiveCharacter('', { variant: 1, hue: null }, 9);
    expect(characterSnapshot('person')).toEqual({ variant: 2, hue: 150 });
    expect(characterSnapshot('')).toBeUndefined();
  });

  it('evicts unattended entries while keeping a currently displayed identity', () => {
    receiveCharacter('visible', { variant: 3, hue: null }, 1);
    const unsubscribe = subscribeCharacter('visible', vi.fn());
    for (let index = 0; index < 1100; index++) {
      receiveCharacter(`unattended-${index}`, { variant: 0, hue: null }, 1);
    }
    expect(characterSnapshot('visible')).toEqual({ variant: 3, hue: null });
    expect(characterSnapshot('unattended-0')).toBeUndefined();
    expect(characterSnapshot('unattended-1099')).toBeDefined();
    const retained = Array.from({ length: 1100 }, (_, index) => characterSnapshot(`unattended-${index}`)).filter(Boolean);
    expect(retained.length).toBeLessThanOrEqual(1023);
    unsubscribe();
  });

  it('clears account identities and informs mounted readers, with no callbacks after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCharacter('person', listener);
    receiveCharacter('person', { variant: 1, hue: null }, 1);
    clearCharacters();
    expect(characterSnapshot('person')).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    receiveCharacter('person', { variant: 2, hue: null }, 2);
    clearCharacters();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('bounds recursive hydration and ignores malformed appearances', () => {
    const recursive: Record<string, unknown> = { user: user('valid') };
    recursive.users = recursive;
    expect(() => observeCharacters(recursive)).not.toThrow();
    expect(characterSnapshot('valid')).toBeDefined();
    observeCharacters({ user: { ...user('bad'), character: { variant: 0, hue: 360 } } });
    expect(characterSnapshot('bad')).toBeUndefined();
    const users = Array.from({ length: 513 }, (_, index) => user(`limited-${index}`));
    observeCharacters({ users });
    expect(characterSnapshot('limited-511')).toBeDefined();
    expect(characterSnapshot('limited-512')).toBeUndefined();
  });
});
