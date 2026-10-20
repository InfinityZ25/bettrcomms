/**
 * The only part of the companion that runs per frame, and only while it is in
 * the air after being thrown. Pure arithmetic so it can be tested without a
 * clock or a DOM; the engine owns the requestAnimationFrame loop and stops it
 * the moment the creature lands.
 *
 * Coordinates are the creature's feet in viewport pixels.
 */
export type Surface = { y: number; left: number; right: number; key: string };
export type Flight = { x: number; y: number; vx: number; vy: number; bounces: number };
export type Arena = { left: number; right: number; top: number };
export type FlightStep = { flight: Flight; landed?: Surface; impact?: 'wall' | 'ceiling' | 'bounce'; speed: number };

export const GRAVITY = 2600;
const MAX_SPEED = 2800;
const BOUNCE_SPEED = 1050;

export function clampSpeed(vx: number, vy: number) {
  const speed = Math.hypot(vx, vy);
  if (speed <= MAX_SPEED) return { vx, vy };
  const scale = MAX_SPEED / speed;
  return { vx: vx * scale, vy: vy * scale };
}

/** Pointer velocity from the samples of the last ~90ms, so a slow drag ending in a flick still flies. */
export function releaseVelocity(samples: readonly { x: number; y: number; t: number }[]) {
  const last = samples[samples.length - 1];
  if (!last) return { vx: 0, vy: 0 };
  const first = samples.find((sample) => last.t - sample.t <= 90) ?? last;
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0.008) return { vx: 0, vy: 0 };
  return clampSpeed((last.x - first.x) / dt, (last.y - first.y) / dt);
}

/** The first surface a body falling straight down from `y` would meet. */
export function surfaceBelow(x: number, y: number, surfaces: readonly Surface[], tolerance = 2) {
  let best: Surface | undefined;
  for (const surface of surfaces) {
    if (x < surface.left || x > surface.right || surface.y < y - tolerance) continue;
    if (!best || surface.y < best.y) best = surface;
  }
  return best;
}

export function stepFlight(flight: Flight, dtSeconds: number, arena: Arena, surfaces: readonly Surface[]): FlightStep {
  const dt = Math.min(dtSeconds, 1 / 30);
  let { x, y, vx, vy, bounces } = flight;
  let impact: FlightStep['impact'];
  vy += GRAVITY * dt;
  vx *= Math.pow(0.6, dt);
  const nextX = x + vx * dt;
  const nextY = y + vy * dt;
  if (nextX < arena.left || nextX > arena.right) {
    x = nextX < arena.left ? arena.left : arena.right;
    vx = -vx * 0.5;
    impact = 'wall';
  } else x = nextX;
  if (nextY < arena.top) {
    y = arena.top;
    vy = Math.abs(vy) * 0.3;
    impact = 'ceiling';
    return { flight: { x, y, vx, vy, bounces }, impact, speed: Math.hypot(vx, vy) };
  }
  if (vy > 0) {
    let hit: Surface | undefined;
    for (const surface of surfaces) {
      if (x < surface.left || x > surface.right) continue;
      if (y > surface.y + 0.5 || nextY < surface.y) continue;
      if (!hit || surface.y < hit.y) hit = surface;
    }
    if (hit) {
      const speed = Math.hypot(vx, vy);
      if (vy > BOUNCE_SPEED && bounces < 1) {
        return {
          flight: { x, y: hit.y, vx: vx * 0.65, vy: -vy * 0.34, bounces: bounces + 1 },
          impact: 'bounce',
          speed,
        };
      }
      return { flight: { x, y: hit.y, vx: 0, vy: 0, bounces }, landed: hit, speed };
    }
  }
  return { flight: { x, y: nextY, vx, vy, bounces }, impact, speed: Math.hypot(vx, vy) };
}
