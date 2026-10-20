import type { CharacterAppearance } from '@/api';

export const CHARACTER_VARIANTS = [0, 1, 2, 3, 4, 5] as const;
export const ORIGINAL_CHARACTER: Readonly<CharacterAppearance> = { variant: 0, hue: null };
export const CHARACTER_COLORS = [
  { hue: 25, label: 'Apricot' },
  { hue: 80, label: 'Gold' },
  { hue: 150, label: 'Fern' },
  { hue: 210, label: 'Sky' },
  { hue: 275, label: 'Violet' },
  { hue: 330, label: 'Rose' },
] as const;

export function validCharacter(value: unknown): value is CharacterAppearance {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as CharacterAppearance;
  return Number.isInteger(candidate.variant) && candidate.variant >= 0 && candidate.variant < CHARACTER_VARIANTS.length
    && (candidate.hue === null || (Number.isInteger(candidate.hue) && candidate.hue >= 0 && candidate.hue < 360));
}

export function characterSeed(userId: string, variant = 0): string {
  return variant === 0 ? userId : `${userId}:companion:${variant}`;
}

export function sameCharacter(left: CharacterAppearance, right: CharacterAppearance) {
  return left.variant === right.variant && left.hue === right.hue;
}
