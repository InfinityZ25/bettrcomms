/**
 * Who a creature is, as opposed to what it looks like.
 *
 * The blobatar generator already turns a seed into a body. This turns the same
 * seed into a temperament, so two creatures that happen to look alike at 48px
 * still move, react and rest differently. Nothing is stored: like the drawing,
 * the personality is a pure function of the character seed, so it follows the
 * account across devices and changes only when its owner picks another
 * creature.
 *
 * The hash is separate from the generator's 32-bit state on purpose. Feeding
 * the same state into both would tie temperament to silhouette, and every
 * round creature would end up with the same mood.
 */
export type TemperamentAxis = 'energy' | 'curiosity' | 'affection' | 'mischief' | 'shyness';
export type Temperament = Record<TemperamentAxis, number>;
export type SignatureMove = 'flip' | 'spin' | 'melt' | 'pogo' | 'wobble' | 'tada';

export type PetPersonality = Temperament & {
  signature: SignatureMove;
  /** Up to two words for the strongest leanings, for people rather than code. */
  traits: string[];
  /** Personal tempo: one hop of a walk, in milliseconds. */
  stepMs: number;
  /** How high a walking hop rises, as a fraction of the creature's size. */
  hop: number;
  /** Mean pause between self-started activities, in milliseconds. */
  restMs: number;
};

const AXES: readonly TemperamentAxis[] = ['energy', 'curiosity', 'affection', 'mischief', 'shyness'];
const SIGNATURES: readonly SignatureMove[] = ['flip', 'spin', 'melt', 'pogo', 'wobble', 'tada'];
const LABELS: Record<TemperamentAxis, readonly [low: string, high: string]> = {
  energy: ['Sleepy', 'Bouncy'],
  curiosity: ['Dreamy', 'Curious'],
  affection: ['Independent', 'Cuddly'],
  mischief: ['Gentle', 'Cheeky'],
  shyness: ['Bold', 'Shy'],
};
export const SIGNATURE_LABELS: Record<SignatureMove, string> = {
  flip: 'Backflip',
  spin: 'Spin',
  melt: 'Melt',
  pogo: 'Pogo',
  wobble: 'Jelly wobble',
  tada: 'Ta-da',
};

/** FNV-1a over the salted key, then a murmur finaliser so neighbouring salts decorrelate. */
export function unitHash(key: string, salt: string): number {
  let hash = 0x811c9dc5;
  const text = `${salt}\u0000${key}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Pushes a uniform value away from the middle. A crowd of creatures that are
 * all "a bit of everything" reads as one creature; this keeps most of them
 * leaning clearly one way on at least a couple of axes.
 */
const lean = (value: number) => 0.5 + Math.sign(value - 0.5) * Math.pow(Math.abs(value - 0.5) * 2, 0.7) / 2;
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;

export function personalityFor(seed: string): PetPersonality {
  const temperament = Object.fromEntries(AXES.map((axis) => [axis, lean(unitHash(seed, `pet:${axis}`))])) as Temperament;
  const signature = SIGNATURES[Math.floor(unitHash(seed, 'pet:signature') * SIGNATURES.length)] ?? 'wobble';
  const traits = AXES
    .map((axis) => ({ axis, strength: Math.abs(temperament[axis] - 0.5) }))
    .filter(({ strength }) => strength >= 0.18)
    .sort((left, right) => right.strength - left.strength)
    .slice(0, 2)
    .map(({ axis }) => LABELS[axis][temperament[axis] >= 0.5 ? 1 : 0]);
  return {
    ...temperament,
    signature,
    traits: traits.length ? traits : ['Easygoing'],
    stepMs: Math.round(mix(430, 250, temperament.energy)),
    hop: mix(0.1, 0.26, temperament.energy),
    restMs: Math.round(mix(11_000, 4_500, temperament.energy)),
  };
}
