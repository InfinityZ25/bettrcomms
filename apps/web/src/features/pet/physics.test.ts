import { describe, expect, it } from 'vitest';
import { releaseVelocity, stepFlight, surfaceBelow, type Flight, type Surface } from './physics';

const arena = { left: 30, right: 970, top: 60 };
const composer: Surface = { key: 'composer', y: 600, left: 40, right: 900 };
const floor: Surface = { key: 'floor', y: 790, left: 30, right: 970 };

function fly(flight: Flight, surfaces: Surface[]) {
  let current = flight;
  for (let frame = 0; frame < 400; frame += 1) {
    const step = stepFlight(current, 1 / 60, arena, surfaces);
    current = step.flight;
    if (step.landed) return { landed: step.landed, flight: current };
  }
  return { flight: current };
}

describe('companion flight', () => {
  it('falls onto the first surface beneath it', () => {
    const { landed, flight } = fly({ x: 300, y: 200, vx: 0, vy: 0, bounces: 0 }, [composer, floor]);
    expect(landed?.key).toBe('composer');
    expect(flight.y).toBe(600);
  });

  it('misses a perch it is not over and reaches the floor', () => {
    expect(fly({ x: 950, y: 200, vx: 0, vy: 0, bounces: 0 }, [composer, floor]).landed?.key).toBe('floor');
  });

  it('bounces once off a hard landing', () => {
    const step = stepFlight({ x: 300, y: 590, vx: 0, vy: 1800, bounces: 0 }, 1 / 60, arena, [composer]);
    expect(step.impact).toBe('bounce');
    expect(step.flight.vy).toBeLessThan(0);
    expect(fly(step.flight, [composer]).landed?.key).toBe('composer');
  });

  it('rebounds off the walls and ceiling', () => {
    const wall = stepFlight({ x: 960, y: 300, vx: 2000, vy: 0, bounces: 0 }, 1 / 60, arena, []);
    expect(wall.impact).toBe('wall');
    expect(wall.flight.vx).toBeLessThan(0);
    const ceiling = stepFlight({ x: 300, y: 70, vx: 0, vy: -2000, bounces: 0 }, 1 / 60, arena, []);
    expect(ceiling.impact).toBe('ceiling');
    expect(ceiling.flight.vy).toBeGreaterThan(0);
  });

  it('measures a flick from the last moments of a drag', () => {
    const { vx, vy } = releaseVelocity([
      { x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 200 }, { x: 40, y: -20, t: 240 }, { x: 80, y: -40, t: 260 },
    ]);
    expect(vx).toBeGreaterThan(1000);
    expect(vy).toBeLessThan(0);
    expect(releaseVelocity([{ x: 0, y: 0, t: 0 }])).toEqual({ vx: 0, vy: 0 });
  });

  it('caps absurd throws', () => {
    expect(releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 5000, y: 0, t: 20 }]).vx).toBeLessThanOrEqual(2800);
  });

  it('finds the nearest surface below a point', () => {
    expect(surfaceBelow(300, 100, [floor, composer])?.key).toBe('composer');
    expect(surfaceBelow(300, 700, [floor, composer])?.key).toBe('floor');
    expect(surfaceBelow(5, 100, [composer])).toBeUndefined();
  });
});
