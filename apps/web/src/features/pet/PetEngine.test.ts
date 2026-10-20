import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PetEngine, type PetElements } from './PetEngine';
import { personalityFor } from './personality';

const motion = vi.hoisted(() => ({
  preference: 'expressive' as 'expressive' | 'quiet',
  listeners: new Set<() => void>(),
}));
const eyes = vi.hoisted(() => ({ stop: vi.fn(), lookAt: vi.fn(), remeasure: vi.fn() }));
vi.mock('@/features/settings/companionMotion', () => ({
  companionMotionSnapshot: () => ({ preference: motion.preference }),
  subscribeCompanionMotion: (listener: () => void) => {
    motion.listeners.add(listener);
    return () => motion.listeners.delete(listener);
  },
}));
vi.mock('blobatar/gaze', () => ({ gaze: vi.fn(() => eyes) }));
vi.mock('./surfaces', async (importOriginal) => ({
  ...await importOriginal<typeof import('./surfaces')>(),
  readPerches: () => [{ key: 'floor', kind: 'floor', surface: { key: 'floor', y: 790, left: 46, right: 978 } }],
}));

type FakeAnimation = { cancel: ReturnType<typeof vi.fn> };
let animations: FakeAnimation[];
let frames: Map<number, FrameRequestCallback>;
let reduced: EventTarget & { matches: boolean };
let engine: PetEngine;
let elements: PetElements;

function node() {
  return Object.assign(new EventTarget(), {
    dataset: {} as Record<string, string>,
    style: { transform: '', removeProperty: vi.fn() },
    replaceChildren: vi.fn(),
    setPointerCapture: vi.fn(),
    animate: vi.fn(() => {
      let reject!: (reason: unknown) => void;
      const finished = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
      const animation = {
        finished,
        cancel: vi.fn(() => reject(new DOMException('Cancelled', 'AbortError'))),
      };
      animations.push(animation);
      return animation;
    }),
  }) as unknown as HTMLElement;
}

function pointer(type: string, x: number, y: number, time: number) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, pointerId: 1, clientX: x, clientY: y, timeStamp: time })) {
    Object.defineProperty(event, key, { value });
  }
  elements.hit.dispatchEvent(event);
}

function quiet() {
  motion.preference = 'quiet';
  for (const listener of motion.listeners) listener();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
  motion.preference = 'expressive';
  motion.listeners.clear();
  eyes.stop.mockClear();
  animations = [];
  frames = new Map();
  let nextFrame = 0;
  reduced = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    innerWidth: 1024, innerHeight: 800, matchMedia: () => reduced,
  }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), {
    hidden: false, fullscreenElement: null, activeElement: null, hasFocus: () => true,
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  elements = {
    root: node(), hop: node(), body: node(), hit: node(), shadow: node(), fx: node(),
    svg: () => ({} as SVGSVGElement),
  };
  engine = new PetEngine(elements, { ...personalityFor('motion-test'), restMs: 100_000 }, 72, {
    setExpression: vi.fn(), setVisit: vi.fn(),
  }, 'me');
});

afterEach(() => {
  engine.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('screen companion motion lifecycle', () => {
  it('does not start idle breathing or dragging when character motion starts off', () => {
    motion.preference = 'quiet';
    engine.start(false);
    const position = elements.root.style.transform;
    pointer('pointerdown', 950, 760, 0);
    pointer('pointermove', 1010, 550, 16);
    expect(elements.root.style.transform).toBe(position);
    vi.advanceTimersByTime(20_000);
    expect(animations).toHaveLength(0);
    expect(frames.size).toBe(0);
  });

  it('cancels a running idle breath and gaze when character motion is switched off', () => {
    engine.start(false);
    vi.advanceTimersByTime(6600);
    expect(animations).toHaveLength(1);
    quiet();
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(eyes.stop).toHaveBeenCalledOnce();
    expect(elements.root.dataset.blink).toBeUndefined();
    vi.advanceTimersByTime(20_000);
    expect(animations).toHaveLength(1);
    motion.preference = 'expressive';
    for (const listener of motion.listeners) listener();
    vi.advanceTimersByTime(6600);
    expect(animations).toHaveLength(2);
  });

  it.each(['quiet', 'reduced'] as const)('cancels a throw and its collision animation when %s motion is enabled', (preference) => {
    engine.start(false);
    pointer('pointerdown', 950, 760, 0);
    pointer('pointermove', 1010, 550, 16);
    pointer('pointerup', 1010, 550, 17);
    expect(frames.size).toBe(1);
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    callback(performance.now() + 16);
    expect(animations).toHaveLength(1);
    expect(frames.size).toBe(1);
    if (preference === 'quiet') quiet();
    else {
      reduced.matches = true;
      reduced.dispatchEvent(new Event('change'));
    }
    expect(frames.size).toBe(0);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(elements.root.dataset.airborne).toBeUndefined();
    expect(elements.root.dataset.still).toBe('true');
    const position = elements.root.style.transform;
    vi.advanceTimersByTime(5000);
    expect(elements.root.style.transform).toBe(position);
    expect(animations).toHaveLength(1);
  });
});
