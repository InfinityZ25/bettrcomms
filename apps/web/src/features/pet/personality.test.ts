import { describe, expect, it } from 'vitest';
import { personalityFor, SIGNATURE_LABELS, unitHash } from './personality';

const AXES = ['energy', 'curiosity', 'affection', 'mischief', 'shyness'] as const;

describe('companion personality', () => {
  it('is a pure function of the character seed', () => {
    expect(personalityFor('user-1')).toEqual(personalityFor('user-1'));
    expect(personalityFor('user-1')).not.toEqual(personalityFor('user-1:companion:2'));
  });

  it('keeps every axis and tempo inside its range', () => {
    for (let index = 0; index < 400; index += 1) {
      const p = personalityFor(`seed-${index}`);
      for (const axis of AXES) {
        expect(p[axis]).toBeGreaterThanOrEqual(0);
        expect(p[axis]).toBeLessThanOrEqual(1);
      }
      expect(p.stepMs).toBeGreaterThanOrEqual(250);
      expect(p.stepMs).toBeLessThanOrEqual(430);
      expect(p.restMs).toBeGreaterThanOrEqual(4500);
      expect(p.restMs).toBeLessThanOrEqual(11_000);
      expect(p.traits.length).toBeGreaterThanOrEqual(1);
      expect(p.traits.length).toBeLessThanOrEqual(2);
      expect(SIGNATURE_LABELS[p.signature]).toBeTruthy();
    }
  });

  it('spreads temperaments rather than giving a crowd one mood', () => {
    const signatures = new Set<string>();
    const leads = new Set<string>();
    let energetic = 0;
    for (let index = 0; index < 600; index += 1) {
      const p = personalityFor(`account-${index}-${index * 7919}`);
      signatures.add(p.signature);
      leads.add(p.traits[0]);
      if (p.energy > 0.5) energetic += 1;
    }
    expect(signatures.size).toBe(6);
    expect(leads.size).toBeGreaterThanOrEqual(9);
    expect(energetic).toBeGreaterThan(220);
    expect(energetic).toBeLessThan(380);
  });

  it('decorrelates salts on the same key', () => {
    const a = Array.from({ length: 300 }, (_, index) => unitHash(`k${index}`, 'pet:energy'));
    const b = Array.from({ length: 300 }, (_, index) => unitHash(`k${index}`, 'pet:shyness'));
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const ma = mean(a);
    const mb = mean(b);
    const covariance = mean(a.map((value, index) => (value - ma) * (b[index] - mb)));
    expect(Math.abs(covariance)).toBeLessThan(0.01);
  });
});
