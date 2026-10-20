import type { Surface } from './physics';

/**
 * Where the companion can stand.
 *
 * Screens opt in by marking an element with `data-pet-perch`; the creature
 * stands on its top edge. The composer is the usual one — the reserved
 * activity row above it leaves room — and a call offers its controls. Any
 * other screen has a content canvas, and the creature sits inside its bottom
 * edge; failing even that, the bottom of the window.
 *
 * These are read when the creature decides where to go, on resize and after
 * navigation, never per frame.
 */
export type PerchKind = 'composer' | 'call' | 'canvas' | 'floor';
export type Perch = {
  key: string;
  kind: PerchKind;
  element?: Element;
  room?: string;
  surface: Surface;
};

const PRIORITY: Record<PerchKind, number> = { composer: 3, call: 2, canvas: 1, floor: 0 };
const EDGE = 10;
/** Stable per element, so a perch keeps its identity when others appear before it in the DOM. */
const ids = new WeakMap<Element, number>();
let nextId = 0;
const idFor = (element: Element) => {
  let id = ids.get(element);
  if (id === undefined) {
    id = ++nextId;
    ids.set(element, id);
  }
  return id;
};

function visible(element: Element, rect: DOMRect) {
  if (rect.width < 80 || rect.height < 8) return false;
  if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return false;
  return typeof element.checkVisibility === 'function' ? element.checkVisibility({ visibilityProperty: true }) : true;
}

export function floorPerch(size: number): Perch {
  const half = size / 2;
  return {
    key: 'floor',
    kind: 'floor',
    surface: { key: 'floor', y: window.innerHeight - EDGE, left: half + EDGE, right: window.innerWidth - half - EDGE },
  };
}

export function readPerches(size: number): Perch[] {
  const half = size / 2;
  const perches: Perch[] = [];
  const elements = document.querySelectorAll('[data-pet-perch], .content-canvas');
  elements.forEach((element) => {
    const kind = (element.getAttribute('data-pet-perch') ?? 'canvas') as PerchKind;
    if (kind !== 'composer' && kind !== 'call' && kind !== 'canvas') return;
    const rect = element.getBoundingClientRect();
    if (!visible(element, rect)) return;
    // Perches are stood on; a canvas is stood in, just inside its rounded bottom edge.
    const inside = kind === 'canvas';
    if (inside ? rect.height < size * 2 : rect.top < size * 0.6) return;
    const inset = inside ? 22 : 6;
    const left = Math.max(rect.left + half + inset, half + EDGE);
    const right = Math.min(rect.right - half - inset, window.innerWidth - half - EDGE);
    if (right - left < 8) return;
    const key = `${kind}:${idFor(element)}`;
    perches.push({
      key,
      kind,
      element,
      room: element.getAttribute('data-pet-room') ?? undefined,
      // One pixel into a perch's border, so the creature sits on the edge rather than hovering over it.
      surface: { key, y: Math.round(inside ? Math.min(rect.bottom, window.innerHeight) - 14 : rect.top + 1), left, right },
    });
  });
  perches.push(floorPerch(size));
  return perches;
}

/**
 * The perch that matters most right now: the composer you are typing in, then
 * any composer on screen, then a call, then the floor. Among equals, the
 * larger one wins, which is the main conversation rather than a side thread.
 */
export function preferredPerch(perches: readonly Perch[], focused: Element | null): Perch {
  let best: Perch | undefined;
  let bestScore = -Infinity;
  for (const perch of perches) {
    const width = perch.surface.right - perch.surface.left;
    const active = perch.element && focused && perch.element.contains(focused) ? 10 : 0;
    const score = active + PRIORITY[perch.kind] + width / 10_000;
    if (score > bestScore) {
      best = perch;
      bestScore = score;
    }
  }
  return best ?? perches[perches.length - 1];
}

/** A point along a perch from a stored 0–1 position. */
export function pointOn(surface: Surface, ratio: number) {
  return surface.left + (surface.right - surface.left) * Math.min(1, Math.max(0, ratio));
}

export function ratioOn(surface: Surface, x: number) {
  const width = surface.right - surface.left;
  return width <= 0 ? 0.5 : Math.min(1, Math.max(0, (x - surface.left) / width));
}
