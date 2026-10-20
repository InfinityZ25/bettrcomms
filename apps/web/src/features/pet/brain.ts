import type { PetPersonality } from './personality';

/**
 * Decisions, without a DOM or a clock.
 *
 * The engine asks two kinds of question: "nothing is happening, what now?" and
 * "this just happened, how do you feel about it?". Both answers come from the
 * creature's temperament, which is what makes one companion potter about and
 * another nap through the afternoon. Randomness is injected so tests can pin it.
 */
export type Expression =
  | 'idle' | 'happy' | 'sad' | 'mad' | 'surprised' | 'wink' | 'sleepy'
  | 'smug' | 'unsure' | 'scared' | 'love' | 'shy' | 'sick' | 'thinking';
export type Emote =
  | 'heart' | 'exclaim' | 'question' | 'note' | 'sparkle' | 'anger'
  | 'sweat' | 'zzz' | 'dots' | 'swirl' | 'confetti';
export type Mouth = 'none' | 'smile' | 'open' | 'o' | 'cat' | 'flat' | 'wavy' | 'talk';
export type BodyMotion =
  | 'boop' | 'perk' | 'jump' | 'shake' | 'shrink' | 'purr' | 'nod' | 'tilt'
  | 'stretch' | 'land' | 'wobble' | 'sway';

export type Reaction = {
  expression: Expression;
  emote?: Emote;
  motion?: BodyMotion;
  mouth?: Mouth;
  blush?: boolean;
  /** How long the face holds before relaxing, in milliseconds. */
  hold: number;
};

export type Activity = 'sit' | 'wander' | 'glance' | 'nap' | 'signature' | 'stretch' | 'explore' | 'hum';
export type ActivityContext = {
  /** Local hour, 0–23. Late nights make everybody drowsier. */
  hour: number;
  /** Time since the creature last woke up. Nobody naps the moment they get up. */
  awakeMs: number;
  /** Perches visible right now; exploring needs somewhere to go. */
  surfaces: number;
  last?: Activity;
  /** Character motion is off: the creature stays where it is. */
  quiet: boolean;
};

type Random = () => number;

function pick<T extends string>(weights: [T, number][], random: Random): T {
  const total = weights.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  let roll = random() * total;
  for (const [value, weight] of weights) {
    roll -= Math.max(0, weight);
    if (roll < 0) return value;
  }
  return weights[0][0];
}

const lateNight = (hour: number) => hour >= 23 || hour < 6;

export function chooseActivity(p: PetPersonality, context: ActivityContext, random: Random = Math.random): Activity {
  const still = context.quiet;
  const drowsy = (lateNight(context.hour) ? 3 : 1) * (context.awakeMs < 90_000 ? 0 : 1);
  const weights: [Activity, number][] = [
    ['sit', 2.6],
    ['glance', 1 + 3 * p.curiosity],
    ['wander', still ? 0 : 0.6 + 3.2 * p.energy],
    ['nap', drowsy * (0.15 + 1.6 * (1 - p.energy))],
    ['signature', still ? 0 : 0.15 + 0.9 * p.mischief + 0.45 * p.energy],
    ['stretch', still ? 0 : 0.35 + 0.6 * (1 - p.energy)],
    ['explore', still || context.surfaces < 2 ? 0 : 1.6 * p.curiosity],
    ['hum', 0.25 + 0.9 * p.affection * (1 - p.shyness * 0.5)],
  ];
  return pick(weights.map(([activity, weight]) => [
    activity,
    activity !== 'sit' && activity === context.last ? weight * 0.25 : weight,
  ]), random);
}

/** Pause before the next self-started activity. Busy creatures fidget sooner. */
export function restDelay(p: PetPersonality, random: Random = Math.random) {
  return Math.round(p.restMs * (0.55 + random() * 0.9));
}

export function boopReaction(p: PetPersonality, streak: number, random: Random = Math.random): Reaction {
  if (streak >= 5) return { expression: 'mad', emote: 'anger', motion: 'shake', mouth: 'flat', hold: 1800 };
  if (streak >= 3 && p.mischief > 0.55) return { expression: 'smug', motion: 'boop', mouth: 'cat', hold: 1200 };
  const mood = pick<'shy' | 'cheeky' | 'warm' | 'startled'>([
    ['shy', p.shyness * 1.4],
    ['cheeky', p.mischief * 1.2],
    ['warm', 0.4 + p.affection],
    ['startled', 0.3 + (1 - p.energy) * 0.4],
  ], random);
  switch (mood) {
    case 'shy': return { expression: 'shy', motion: 'shrink', blush: true, hold: 1400 };
    case 'cheeky': return { expression: 'wink', motion: 'boop', mouth: 'cat', hold: 1100 };
    case 'warm': return { expression: 'happy', emote: 'heart', motion: 'boop', mouth: 'smile', hold: 1200 };
    default: return { expression: 'surprised', motion: 'boop', mouth: 'o', hold: 900 };
  }
}

export function pettedReaction(p: PetPersonality): Reaction {
  if (p.shyness > 0.72 && p.affection < 0.45) return { expression: 'shy', blush: true, motion: 'shrink', hold: 1800 };
  return { expression: 'love', emote: 'heart', motion: 'purr', blush: true, mouth: 'cat', hold: 2200 };
}

/** The face it pulls while dangling from the pointer. */
export function heldReaction(p: PetPersonality): Reaction {
  if (p.energy > 0.62) return { expression: 'happy', mouth: 'open', hold: 0 };
  if (p.shyness > 0.6) return { expression: 'scared', mouth: 'wavy', emote: 'sweat', hold: 0 };
  return { expression: 'surprised', mouth: 'o', hold: 0 };
}

export function landingReaction(p: PetPersonality, speed: number): Reaction {
  if (speed > 1900) return { expression: 'sick', emote: 'swirl', motion: 'wobble', mouth: 'wavy', hold: 2200 };
  if (speed > 1000) {
    return p.energy > 0.55
      ? { expression: 'happy', emote: 'sparkle', motion: 'land', mouth: 'open', hold: 1300 }
      : { expression: 'unsure', emote: 'sweat', motion: 'land', hold: 1300 };
  }
  return { expression: 'idle', motion: 'land', hold: 0 };
}

export function messageReaction(p: PetPersonality, message: { mention: boolean; here: boolean; own: boolean; length: number }): Reaction {
  if (message.own) {
    return message.length > 160
      ? { expression: 'surprised', emote: 'sparkle', motion: 'jump', mouth: 'o', hold: 1100 }
      : { expression: 'happy', emote: p.affection > 0.5 ? 'sparkle' : undefined, motion: 'perk', mouth: 'smile', hold: 900 };
  }
  if (message.mention) return { expression: 'surprised', emote: 'exclaim', motion: 'jump', mouth: 'o', hold: 1600 };
  if (!message.here) return { expression: p.curiosity > 0.5 ? 'surprised' : 'idle', emote: 'exclaim', motion: 'perk', hold: 900 };
  return { expression: p.affection > 0.6 ? 'happy' : 'idle', motion: 'perk', hold: 700 };
}

export function gestureReaction(p: PetPersonality, gesture: 'wave' | 'nod' | 'celebrate'): Reaction {
  if (p.shyness > 0.7) return { expression: 'shy', blush: true, motion: 'shrink', emote: 'heart', hold: 1600 };
  if (gesture === 'celebrate') return { expression: 'happy', emote: 'confetti', motion: 'jump', mouth: 'open', hold: 1600 };
  if (gesture === 'nod') return { expression: 'happy', motion: 'nod', mouth: 'smile', hold: 1200 };
  return { expression: 'happy', emote: 'note', motion: 'tilt', mouth: 'smile', hold: 1300 };
}

/** Coming back after a while away. Affectionate creatures missed you more. */
export function welcomeReaction(p: PetPersonality, awayMs: number): Reaction {
  if (awayMs > 20 * 60_000 && p.affection > 0.5) return { expression: 'love', emote: 'heart', motion: 'jump', blush: true, mouth: 'open', hold: 1800 };
  if (p.mischief > 0.7) return { expression: 'smug', motion: 'tilt', mouth: 'cat', hold: 1300 };
  return { expression: 'happy', emote: p.affection > 0.4 ? 'heart' : 'note', motion: 'perk', mouth: 'smile', hold: 1300 };
}

export const NAP_AFTER_IDLE_MS = 75_000;
