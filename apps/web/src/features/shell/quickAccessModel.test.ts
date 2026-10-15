import { describe, expect, it } from 'vitest';
import type { PublicUser, Room } from '@/api';
import {
  isQuickAccessShortcut,
  normalizeQuickSearch,
  quickAccessGroups,
  quickAccessItems,
} from './quickAccessModel';

const room = (id: string, name: string, extra: Partial<Room> = {}): Room => ({
  id,
  name,
  owner_id: 'owner',
  created_at: '2026-10-01T00:00:00Z',
  ...extra,
});
const friend: PublicUser = {
  id: 'friend',
  name: 'José Muñoz',
  username: 'joseito',
};
const flat = (query: string, rooms: Room[] = [], friends: PublicUser[] = []) =>
  quickAccessGroups(quickAccessItems(rooms, friends), query).flatMap(
    (group) => group.items,
  );

describe('quick access index', () => {
  it('matches accented names, combined name tokens and username prefixes', () => {
    expect(normalizeQuickSearch('  JOSÉ Muñoz ')).toBe('jose munoz');
    expect(flat('munoz jose', [], [friend]).map((item) => item.id)).toEqual([
      'friend:friend',
    ]);
    expect(flat('@joseito', [], [friend]).map((item) => item.id)).toEqual([
      'friend:friend',
    ]);
  });

  it('puts an exact title ahead of a secondary topic or community match', () => {
    const items = flat('audio', [
      room('topic', 'General', { topic: 'audio' }),
      room('exact', 'Audio'),
    ]);
    expect(items[0].id).toBe('room:exact');
    expect(items.findIndex((item) => item.id === 'room:exact')).toBeLessThan(
      items.findIndex((item) => item.id === 'room:topic'),
    );
  });

  it('disambiguates identically named channels by community and searches both', () => {
    const rooms = [
      room('one', 'general', { community_id: 'a', community_name: 'Amigos' }),
      room('two', 'general', { community_id: 'b', community_name: 'Trabajo' }),
    ];
    expect(flat('#general trabajo', rooms).map((item) => item.id)).toContain(
      'room:two',
    );
    expect(
      flat('#general trabajo', rooms).map((item) => item.id),
    ).not.toContain('room:one');
    expect(
      quickAccessItems(rooms, []).find((item) => item.id === 'room:one')
        ?.subtitle,
    ).toBe('Amigos · Text and voice');
  });

  it('indexes a community only through its accessible channels and removes revoked entries', () => {
    const allowed = room('public', 'Visible', {
      community_id: 'a',
      community_name: 'Friends',
      position: 2,
    });
    const hidden = room('hidden', 'Secret', {
      community_id: 'a',
      community_name: 'Friends',
      position: 0,
      permissions: { read: false } as Room['permissions'],
    });
    const items = quickAccessItems([allowed, hidden], []);
    expect(items.some((item) => item.id === 'room:hidden')).toBe(false);
    const community = items.find((item) => item.id === 'community:a');
    expect(community?.subtitle).toBe('Room · 1 accessible channel');
    expect(community?.destination).toEqual({ kind: 'room', room: allowed });
    expect(flat('secret', [allowed, hidden])).toEqual([]);
    expect(
      quickAccessItems([], []).some((item) => item.id === 'community:a'),
    ).toBe(false);
  });

  it('prefers favorites and recent activity for the empty query', () => {
    const rooms = [
      room('older', 'Old'),
      room('recent', 'Recent', { activity_at: '2026-10-15T12:00:00Z' }),
      room('favorite', 'Favorite'),
    ];
    const items = quickAccessItems(rooms, [], {
      favorite: { favorite: true, archived: false, version: 1 },
    });
    expect(
      quickAccessGroups(items, '')[0].items.map((item) => item.id),
    ).toEqual(['room:favorite', 'room:recent', 'room:older']);
  });

  it('bounds result rendering while finding later authorized entries', () => {
    const rooms = Array.from({ length: 2000 }, (_, index) =>
      room(`id${index}`, `Channel ${index}`),
    );
    const all = quickAccessItems(rooms, []);
    const shown = quickAccessGroups(all, '').flatMap((group) => group.items);
    expect(shown.length).toBeLessThanOrEqual(24);
    expect(
      quickAccessGroups(all, 'Channel 1999')
        .flatMap((group) => group.items)
        .map((item) => item.id),
    ).toEqual(['room:id1999']);
  });

  it('has matching settings destinations and hides desktop-only controls on web', () => {
    expect(flat('microfono')[0].destination).toEqual({
      kind: 'setting',
      page: 'voice',
    });
    expect(flat('apariencia')[0].destination).toEqual({
      kind: 'setting',
      page: 'appearance',
    });
    expect(
      quickAccessItems([], []).some((item) => item.id === 'setting:desktop'),
    ).toBe(false);
    expect(
      quickAccessItems([], [], {}, true).some(
        (item) => item.id === 'setting:desktop',
      ),
    ).toBe(true);
  });

  it('does not keep a destination from another account or duplicate API rows', () => {
    expect(
      quickAccessItems([room('a', 'Private A')], [friend]).filter(
        (item) => item.group === 'Friends',
      ),
    ).toHaveLength(1);
    expect(flat('private a')).toEqual([]);
    expect(
      quickAccessItems(
        [room('a', 'Private A'), room('a', 'Private A')],
        [],
      ).filter((item) => item.id === 'room:a'),
    ).toHaveLength(1);
  });
});

describe('quick access keyboard intent', () => {
  const event = {
    key: 'k',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
  };
  it('accepts Ctrl+K and Meta+K', () => {
    expect(isQuickAccessShortcut(event)).toBe(true);
    expect(
      isQuickAccessShortcut({
        ...event,
        ctrlKey: false,
        metaKey: true,
        key: 'K',
      }),
    ).toBe(true);
  });
  it.each([
    'shiftKey',
    'altKey',
    'repeat',
    'isComposing',
    'defaultPrevented',
  ] as const)('ignores %s', (key) => {
    expect(isQuickAccessShortcut({ ...event, [key]: true })).toBe(false);
  });
  it('does not claim plain K or the message search shortcut', () => {
    expect(isQuickAccessShortcut({ ...event, ctrlKey: false })).toBe(false);
    expect(isQuickAccessShortcut({ ...event, key: 'f', shiftKey: true })).toBe(
      false,
    );
  });
});
