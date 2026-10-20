import { describe, expect, it } from 'vitest';
import {
  boopReaction, chooseActivity, landingReaction, messageReaction, pettedReaction, restDelay, type ActivityContext,
} from './brain';
import { personalityFor, type PetPersonality } from './personality';

const base = personalityFor('brain-test');
const tuned = (overrides: Partial<PetPersonality>): PetPersonality => ({ ...base, ...overrides });
const context: ActivityContext = { hour: 14, awakeMs: 5 * 60_000, surfaces: 1, quiet: false };
const fixed = (value: number) => () => value;

describe('companion decisions', () => {
  it('never moves around when character motion is off', () => {
    for (let index = 0; index < 200; index += 1) {
      const activity = chooseActivity(base, { ...context, quiet: true }, fixed(index / 200));
      expect(['wander', 'signature', 'stretch', 'explore']).not.toContain(activity);
    }
  });

  it('does not nap right after waking up', () => {
    const sleepy = tuned({ energy: 0 });
    for (let index = 0; index < 200; index += 1) {
      expect(chooseActivity(sleepy, { ...context, awakeMs: 10_000 }, fixed(index / 200))).not.toBe('nap');
    }
  });

  it('naps more at night and when tired', () => {
    const naps = (p: PetPersonality, hour: number) => Array.from({ length: 400 }, (_, index) =>
      chooseActivity(p, { ...context, hour }, fixed(index / 400))).filter((activity) => activity === 'nap').length;
    expect(naps(tuned({ energy: 0.05 }), 2)).toBeGreaterThan(naps(tuned({ energy: 0.05 }), 14));
    expect(naps(tuned({ energy: 0.05 }), 14)).toBeGreaterThan(naps(tuned({ energy: 0.95 }), 14));
  });

  it('fidgets sooner when energetic', () => {
    expect(restDelay({ ...base, restMs: 4500 }, fixed(0.5))).toBeLessThan(restDelay({ ...base, restMs: 11_000 }, fixed(0.5)));
  });

  it('gets annoyed when booped too often', () => {
    expect(boopReaction(base, 5)).toMatchObject({ expression: 'mad', emote: 'anger' });
    expect(boopReaction(base, 1, fixed(0.99)).motion).toBeDefined();
  });

  it('lets shy creatures stay shy when petted', () => {
    expect(pettedReaction(tuned({ shyness: 0.9, affection: 0.2 })).expression).toBe('shy');
    expect(pettedReaction(tuned({ shyness: 0.2, affection: 0.8 })).expression).toBe('love');
  });

  it('gets dizzy from a hard throw', () => {
    expect(landingReaction(base, 2400).expression).toBe('sick');
    expect(landingReaction(base, 200).expression).toBe('idle');
  });

  it('reacts loudest to a mention and quietly to the conversation you are reading', () => {
    expect(messageReaction(base, { mention: true, here: true, own: false, length: 4 }))
      .toMatchObject({ expression: 'surprised', emote: 'exclaim', motion: 'jump' });
    expect(messageReaction(base, { mention: false, here: true, own: false, length: 4 }).emote).toBeUndefined();
    expect(messageReaction(base, { mention: false, here: false, own: false, length: 4 }).emote).toBe('exclaim');
  });
});
