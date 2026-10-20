import { describe, expect, it } from 'vitest';
import { blobatar } from 'blobatar';
import { blobatarFor, hueFor } from './blobatarIdentity';
import {
  CHARACTER_COLORS,
  CHARACTER_VARIANTS,
  ORIGINAL_CHARACTER,
  characterSeed,
  sameCharacter,
  validCharacter,
} from './character';

const account = '1915d8e1-2c50-4e10-bb37-dda320b19121';

describe('personal character identity', () => {
  it('preserves the existing account character and color when no choice was made', () => {
    const original = blobatarFor(account);
    expect(original).toEqual({ name: account, hue: hueFor(account) });
    expect(blobatarFor(account, ORIGINAL_CHARACTER)).toEqual(original);
    expect(blobatar(original.name, original)).toBe(blobatar(account, { hue: hueFor(account) }));
    expect(characterSeed(account, 0)).toBe(account);
  });

  it('reconstructs distinct selectable drawings for one stable account', () => {
    const first = CHARACTER_VARIANTS.map((variant) => blobatarFor(account, { variant, hue: null }));
    const second = CHARACTER_VARIANTS.map((variant) => blobatarFor(account, { variant, hue: null }));
    expect(second).toEqual(first);
    expect(new Set(first.map(({ name }) => name)).size).toBe(CHARACTER_VARIANTS.length);
    // Compare drawing primitives rather than labels or the seed in SVG metadata.
    const drawings = first.map((identity) => blobatar(identity.name, identity).match(/<(?:path|circle)\b[^>]*>/g)?.join(''));
    expect(drawings.every(Boolean)).toBe(true);
    expect(new Set(drawings).size).toBe(CHARACTER_VARIANTS.length);
    expect(characterSeed('another-account', 1)).not.toBe(characterSeed(account, 1));
  });

  it('changes color without changing the selected creature and restores its original palette', () => {
    const automatic = blobatarFor(account, { variant: 3, hue: null });
    const selected = blobatarFor(account, { variant: 3, hue: 210 });
    expect(selected).toEqual({ name: automatic.name, hue: 210 });
    expect(blobatarFor(account, { variant: 3, hue: null })).toEqual(automatic);
    expect(sameCharacter({ variant: 3, hue: null }, { variant: 3, hue: null })).toBe(true);
    expect(sameCharacter({ variant: 3, hue: null }, { variant: 3, hue: 210 })).toBe(false);
  });

  it.each([
    null, undefined, false, 'character', {}, { variant: 0 },
    { variant: -1, hue: null }, { variant: 6, hue: null },
    { variant: 0.5, hue: null }, { variant: NaN, hue: null },
    { variant: '0', hue: null }, { variant: 0, hue: -1 },
    { variant: 0, hue: 360 }, { variant: 0, hue: 359.5 },
    { variant: 0, hue: NaN }, { variant: 0, hue: Infinity },
    { variant: 0, hue: '25' },
  ])('rejects an invalid persisted appearance: %j', (value) => {
    expect(validCharacter(value)).toBe(false);
  });

  it('accepts every offered variant and swatch plus both valid hue boundaries', () => {
    for (const variant of CHARACTER_VARIANTS) {
      expect(validCharacter({ variant, hue: null })).toBe(true);
      for (const { hue } of CHARACTER_COLORS) expect(validCharacter({ variant, hue })).toBe(true);
    }
    expect(validCharacter({ variant: 0, hue: 0 })).toBe(true);
    expect(validCharacter({ variant: 5, hue: 359 })).toBe(true);
  });
});
