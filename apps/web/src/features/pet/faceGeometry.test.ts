import { describe, expect, it } from 'vitest';
import { faceGeometry, mouthPaths } from './faceGeometry';

const body = { x: 18, y: 20, width: 64, height: 60 };
const eyes = [{ x: 56, y: 38, width: 5, height: 14 }, { x: 37, y: 38, width: 5, height: 14 }];

describe('borrowed face geometry', () => {
  it('puts the mouth between and below the eyes, inside the body', () => {
    const { mouth } = faceGeometry(body, eyes);
    expect(mouth.x).toBeCloseTo((39.5 + 58.5) / 2);
    expect(mouth.y).toBeGreaterThan(52);
    expect(mouth.y + mouth.width).toBeLessThan(body.y + body.height);
  });

  it('puts cheeks outside the eyes', () => {
    const { cheeks } = faceGeometry(body, eyes);
    expect(cheeks[0].x).toBeLessThan(39.5);
    expect(cheeks[1].x).toBeGreaterThan(58.5);
  });

  it('lines the drawing up so its feet are the frame’s', () => {
    const { feet, span } = faceGeometry(body, eyes);
    expect(feet).toEqual({ dx: 0, dy: 20 });
    expect(span).toBeCloseTo(0.64);
  });

  it('survives a face it could not measure', () => {
    const geometry = faceGeometry(body, []);
    expect(Number.isFinite(geometry.mouth.x)).toBe(true);
    for (const path of Object.values(mouthPaths(geometry.mouth))) expect(path).not.toMatch(/NaN/);
  });
});
