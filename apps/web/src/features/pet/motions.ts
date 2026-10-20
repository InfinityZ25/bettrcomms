import type { BodyMotion } from './brain';
import type { SignatureMove } from './personality';

/**
 * Keyframes for the companion's body.
 *
 * Every one of these animates `transform` on an HTML wrapper and nothing else,
 * which the browser can run on the compositor without touching layout, paint
 * or JavaScript for the length of the motion. The drawing inside never changes
 * shape; squash and stretch is the wrapper scaling around the creature's feet.
 *
 * The vocabulary is a slime's: it anticipates by squashing, stretches as it
 * leaves the ground, flattens when it lands and wobbles until it settles.
 */
export type Motion = {
  frames: Keyframe[];
  duration: number;
  easing?: string;
  /** Shadow keyframes for motions that leave the ground. */
  shadow?: Keyframe[];
};

const t = (transform: string, offset?: number, extra: Keyframe = {}): Keyframe =>
  offset === undefined ? { transform, ...extra } : { transform, offset, ...extra };
const shadow = (pairs: [number, number][]): Keyframe[] =>
  pairs.map(([offset, scale]) => ({ offset, transform: `scale(${scale})`, opacity: 0.35 + scale * 0.65 }));

export const BODY_MOTIONS: Record<BodyMotion, Motion> = {
  boop: { duration: 520, frames: [
    t('none', 0), t('scale(1.2,.78)', 0.18), t('scale(.9,1.12)', 0.45), t('scale(1.05,.96)', 0.7), t('none', 1),
  ] },
  perk: { duration: 520, frames: [
    t('none', 0), t('scale(1.08,.92)', 0.2), t('translateY(-12%) scale(.94,1.08)', 0.48), t('scale(1.06,.95)', 0.78), t('none', 1),
  ], shadow: shadow([[0, 1], [0.48, 0.8], [0.78, 1], [1, 1]]) },
  jump: { duration: 860, frames: [
    t('none', 0), t('scale(1.22,.76)', 0.16), t('translateY(-62%) scale(.86,1.16)', 0.46),
    t('translateY(-66%) scale(.96,1.04)', 0.56), t('scale(1.24,.78)', 0.8), t('scale(.95,1.05)', 0.9), t('none', 1),
  ], shadow: shadow([[0, 1], [0.16, 1.1], [0.5, 0.45], [0.8, 1.15], [1, 1]]) },
  shake: { duration: 680, frames: [
    t('none', 0), t('rotate(-9deg)', 0.1), t('rotate(9deg)', 0.25), t('rotate(-7deg)', 0.4),
    t('rotate(6deg)', 0.55), t('rotate(-3deg)', 0.72), t('none', 1),
  ] },
  shrink: { duration: 1100, frames: [
    t('none', 0), t('translateY(3%) scale(.86,.84)', 0.28), t('translateY(3%) scale(.87,.83)', 0.72), t('none', 1),
  ] },
  purr: { duration: 1300, easing: 'ease-in-out', frames: [
    t('none', 0), ...Array.from({ length: 7 }, (_, index) =>
      t(index % 2 ? 'scale(.98,1.02)' : 'scale(1.05,.95)', (index + 1) / 8)), t('none', 1),
  ] },
  nod: { duration: 820, frames: [
    t('none', 0), t('translateY(5%) scale(1.06,.9) rotate(4deg)', 0.25), t('none', 0.5),
    t('translateY(5%) scale(1.06,.9) rotate(4deg)', 0.75), t('none', 1),
  ] },
  tilt: { duration: 940, easing: 'ease-in-out', frames: [
    t('none', 0), t('rotate(-13deg)', 0.2), t('rotate(11deg)', 0.45), t('rotate(-8deg)', 0.68), t('rotate(4deg)', 0.86), t('none', 1),
  ] },
  stretch: { duration: 1500, easing: 'ease-in-out', frames: [
    t('none', 0), t('scale(.88,1.24)', 0.35), t('scale(.9,1.22) rotate(3deg)', 0.6), t('scale(1.14,.86)', 0.8), t('none', 1),
  ] },
  land: { duration: 620, frames: [
    t('scale(1.3,.7)', 0), t('scale(.9,1.13)', 0.3), t('scale(1.06,.95)', 0.55), t('scale(.98,1.02)', 0.78), t('none', 1),
  ] },
  wobble: { duration: 1200, easing: 'ease-out', frames: [
    t('none', 0), t('skewX(11deg) scale(1.06,.94)', 0.14), t('skewX(-9deg) scale(.96,1.04)', 0.3),
    t('skewX(7deg)', 0.46), t('skewX(-4deg)', 0.62), t('skewX(2deg)', 0.8), t('none', 1),
  ] },
  sway: { duration: 2200, easing: 'ease-in-out', frames: [
    t('none', 0), t('rotate(-6deg) scale(1.02,.98)', 0.25), t('rotate(6deg) scale(1.02,.98)', 0.62), t('none', 1),
  ] },
};

const centre = { transformOrigin: '50% 58%' };
export const SIGNATURE_MOTIONS: Record<SignatureMove, Motion> = {
  flip: { duration: 1050, frames: [
    t('none', 0, centre), t('translateY(6%) scale(1.18,.8)', 0.15, centre),
    t('translateY(-78%) rotate(-180deg) scale(.95,1.05)', 0.5, centre),
    t('translateY(-22%) rotate(-330deg)', 0.78, centre), t('rotate(-360deg) scale(1.22,.8)', 0.9, centre),
    t('rotate(-360deg)', 1, centre),
  ], shadow: shadow([[0, 1], [0.15, 1.1], [0.5, 0.4], [0.9, 1.15], [1, 1]]) },
  spin: { duration: 1000, easing: 'ease-in-out', frames: [
    t('none', 0), t('translateY(-14%) scale(.08,1.04)', 0.2), t('translateY(-22%) scale(-1,1)', 0.4),
    t('translateY(-14%) scale(.08,1.04)', 0.6), t('scale(1,1)', 0.8), t('scale(1.1,.92)', 0.9), t('none', 1),
  ], shadow: shadow([[0, 1], [0.4, 0.7], [0.8, 1], [1, 1]]) },
  melt: { duration: 1800, frames: [
    t('none', 0), t('scale(1.3,.55)', 0.22), t('scale(1.46,.34)', 0.4), t('scale(1.48,.32)', 0.62),
    t('scale(.84,1.26)', 0.8), t('scale(1.06,.95)', 0.9), t('none', 1),
  ], shadow: shadow([[0, 1], [0.4, 1.45], [0.62, 1.45], [0.8, 0.9], [1, 1]]) },
  pogo: { duration: 1300, frames: [0, 1, 2].flatMap((hop) => {
    const start = hop / 3;
    return [
      t('scale(1.16,.82)', start), t(`translateY(-${40 + hop * 14}%) scale(.92,1.1)`, start + 1 / 6), t('scale(1.16,.82)', start + 1 / 3 - 0.001),
    ];
  }).concat(t('none', 1)), shadow: shadow([[0, 1], [1 / 6, 0.6], [1 / 3, 1], [0.5, 0.55], [2 / 3, 1], [5 / 6, 0.5], [1, 1]]) },
  wobble: { duration: 1500, easing: 'ease-out', frames: [
    t('none', 0), t('skewX(16deg) scale(1.1,.9)', 0.12), t('skewX(-14deg) scale(.92,1.08)', 0.26),
    t('skewX(11deg) scale(1.06,.94)', 0.4), t('skewX(-8deg)', 0.54), t('skewX(5deg)', 0.68), t('skewX(-2deg)', 0.84), t('none', 1),
  ] },
  tada: { duration: 1150, frames: [
    t('none', 0, centre), t('translateY(5%) scale(1.15,.84)', 0.14, centre), t('translateY(-48%) rotate(-12deg) scale(1.05)', 0.38, centre),
    t('translateY(-56%) rotate(12deg) scale(1.12)', 0.56, centre), t('translateY(0) scale(1.18,.84)', 0.8, centre),
    t('scale(.96,1.05)', 0.9, centre), t('none', 1, centre),
  ], shadow: shadow([[0, 1], [0.14, 1.1], [0.47, 0.5], [0.8, 1.1], [1, 1]]) },
};

/** One step of a walk: lean off the ground, land, squash. Repeated per step. */
export function stepFrames(height: number): { hop: Keyframe[]; body: Keyframe[] } {
  return {
    hop: [
      { offset: 0, transform: 'translateY(0)', easing: 'cubic-bezier(.3,.8,.5,1)' },
      { offset: 0.45, transform: `translateY(${-height}px)`, easing: 'cubic-bezier(.5,0,.7,.4)' },
      { offset: 0.92, transform: 'translateY(0)' },
      { offset: 1, transform: 'translateY(0)' },
    ],
    body: [
      { offset: 0, transform: 'scale(1.12,.88)' },
      { offset: 0.25, transform: 'scale(.93,1.09)' },
      { offset: 0.6, transform: 'scale(1,1)' },
      { offset: 0.92, transform: 'scale(1.14,.86)' },
      { offset: 1, transform: 'scale(1.12,.88)' },
    ],
  };
}

/** A single arc between two points: anticipation, flight, landing. */
export function leapFrames(height: number): { hop: Keyframe[]; body: Keyframe[]; shadow: Keyframe[] } {
  return {
    hop: [
      { offset: 0, transform: 'translateY(0)' },
      { offset: 0.14, transform: 'translateY(0)', easing: 'cubic-bezier(.2,.7,.4,1)' },
      { offset: 0.55, transform: `translateY(${-height}px)`, easing: 'cubic-bezier(.6,0,.8,.5)' },
      { offset: 0.88, transform: 'translateY(0)' },
      { offset: 1, transform: 'translateY(0)' },
    ],
    body: [
      { offset: 0, transform: 'none' },
      { offset: 0.14, transform: 'scale(1.22,.78)' },
      { offset: 0.3, transform: 'scale(.86,1.16)' },
      { offset: 0.6, transform: 'scale(.97,1.03)' },
      { offset: 0.88, transform: 'scale(1.26,.76)' },
      { offset: 0.95, transform: 'scale(.95,1.05)' },
      { offset: 1, transform: 'none' },
    ],
    shadow: shadow([[0, 1], [0.14, 1.1], [0.55, 0.35], [0.88, 1.1], [1, 1]]),
  };
}
