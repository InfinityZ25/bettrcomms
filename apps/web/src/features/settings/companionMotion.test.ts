import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MotionModule = typeof import('./companionMotion');
type FakeAnimation = {
  animation: Animation;
  cancel: ReturnType<typeof vi.fn>;
  finish: () => void;
};
let motion: MotionModule;
let unsubscribe: () => void;
let media: EventTarget & { matches: boolean };
let browserDocument: EventTarget & { hidden: boolean; documentElement: { dataset: Record<string, string> } };
let animations: FakeAnimation[];

function makeNode(bounds = { width: 40, height: 40, top: 10, left: 10, right: 50, bottom: 50 }) {
  const animate = vi.fn((_frames: Keyframe[] | PropertyIndexedKeyframes | null, _options?: number | KeyframeAnimationOptions) => {
    let finish!: () => void;
    let reject!: (reason?: unknown) => void;
    const finished = new Promise<void>((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
    const cancel = vi.fn(() => reject(new DOMException('Cancelled', 'AbortError')));
    const animation = { finished, cancel } as unknown as Animation;
    animations.push({ animation, cancel, finish });
    return animation;
  });
  return { animate, getBoundingClientRect: () => bounds } as unknown as HTMLElement & { animate: typeof animate };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  media = Object.assign(new EventTarget(), { matches: false });
  browserDocument = Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: {} } });
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    matchMedia: vi.fn(() => media), innerWidth: 1024, innerHeight: 768,
  }));
  vi.stubGlobal('document', browserDocument);
  animations = [];
  motion = await import('./companionMotion');
  unsubscribe = motion.subscribeCompanionMotion(() => {});
});
afterEach(async () => {
  unsubscribe();
  motion.clearCompanionMotion();
  await Promise.resolve();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('finite companion motion', () => {
  it('starts after StrictMode ref replay and cancels on real unmount without replaying on navigation', async () => {
    const node = makeNode();
    const firstCleanup = motion.scheduleCompanionMotion(node, { gesture: { id: 'strict-event', kind: 'wave' } });
    firstCleanup();
    const finalCleanup = motion.scheduleCompanionMotion(node, { gesture: { id: 'strict-event', kind: 'wave' } });
    expect(node.animate).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(node.animate).toHaveBeenCalledTimes(1);
    expect(animations[0].cancel).not.toHaveBeenCalled();
    finalCleanup();
    await Promise.resolve();
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    const remounted = makeNode();
    motion.scheduleCompanionMotion(remounted, { gesture: { id: 'strict-event', kind: 'wave' } });
    await Promise.resolve();
    expect(remounted.animate).not.toHaveBeenCalled();
  });

  it('keeps a started animation through late StrictMode ref and subscription replay', async () => {
    const node = makeNode();
    const firstCleanup = motion.scheduleCompanionMotion(node, { arrivalId: 'late-strict-arrival' });
    await Promise.resolve();
    expect(node.animate).toHaveBeenCalledTimes(1);
    firstCleanup();
    unsubscribe();
    const cleanup = motion.scheduleCompanionMotion(node, { arrivalId: 'late-strict-arrival' });
    unsubscribe = motion.subscribeCompanionMotion(() => {});
    await Promise.resolve();
    expect(node.animate).toHaveBeenCalledTimes(1);
    expect(animations[0].cancel).not.toHaveBeenCalled();
    cleanup();
    await Promise.resolve();
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
  });

  it('consumes expired arrivals without showing them after returning to a call', () => {
    const node = makeNode();
    motion.animateCompanion(node, { arrivalId: 'old-arrival', arrivalAt: Date.now() - 1501 });
    motion.animateCompanion(node, { arrivalId: 'old-arrival', arrivalAt: Date.now() });
    expect(node.animate).not.toHaveBeenCalled();
    motion.animateCompanion(node, { arrivalId: 'fresh-arrival', arrivalAt: Date.now() });
    expect(node.animate).toHaveBeenCalledTimes(1);
  });

  it('consumes an arrival once across cleanup, remount, and another copy of the participant', async () => {
    const node = makeNode();
    const cleanup = motion.animateCompanion(node, { arrivalId: 'call:a:participant' });
    expect(node.animate).toHaveBeenCalledTimes(1);
    cleanup?.();
    await Promise.resolve();
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    motion.animateCompanion(node, { arrivalId: 'call:a:participant' });
    const remounted = makeNode();
    motion.animateCompanion(remounted, { arrivalId: 'call:a:participant' });
    expect(remounted.animate).not.toHaveBeenCalled();
    motion.animateCompanion(node, { arrivalId: 'call:b:participant' });
    expect(node.animate).toHaveBeenCalledTimes(2);
  });

  it('deduplicates intentional gesture events independently of navigation', () => {
    const node = makeNode();
    motion.animateCompanion(node, { gesture: { id: 'event-1', kind: 'wave' } });
    motion.animateCompanion(node, { gesture: { id: 'event-1', kind: 'wave' } });
    const remounted = makeNode();
    motion.animateCompanion(remounted, { gesture: { id: 'event-1', kind: 'wave' } });
    expect(node.animate).toHaveBeenCalledTimes(1);
    expect(remounted.animate).not.toHaveBeenCalled();
  });

  it('consumes events in quiet mode instead of replaying them when movement is restored', () => {
    const node = makeNode();
    motion.setCompanionMotion('quiet');
    motion.animateCompanion(node, { arrivalId: 'quiet-arrival' });
    motion.animateCompanion(node, { gesture: { id: 'quiet-gesture', kind: 'nod' } });
    expect(node.animate).not.toHaveBeenCalled();
    motion.setCompanionMotion('expressive');
    motion.animateCompanion(node, { arrivalId: 'quiet-arrival' });
    motion.animateCompanion(node, { gesture: { id: 'quiet-gesture', kind: 'nod' } });
    expect(node.animate).not.toHaveBeenCalled();
    motion.animateCompanion(node, { arrivalId: 'new-arrival' });
    expect(node.animate).toHaveBeenCalledTimes(1);
  });

  it('cancels movement in the background and never replays hidden arrivals', async () => {
    const node = makeNode();
    motion.animateCompanion(node, { arrivalId: 'visible' });
    browserDocument.hidden = true;
    browserDocument.dispatchEvent(new Event('visibilitychange'));
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    expect(motion.companionMotionSnapshot().enabled).toBe(false);
    motion.animateCompanion(node, { arrivalId: 'hidden' });
    await Promise.resolve();
    browserDocument.hidden = false;
    browserDocument.dispatchEvent(new Event('visibilitychange'));
    motion.animateCompanion(node, { arrivalId: 'hidden' });
    expect(node.animate).toHaveBeenCalledTimes(1);
    motion.animateCompanion(node, { arrivalId: 'new-visible' });
    expect(node.animate).toHaveBeenCalledTimes(2);
  });

  it('respects system reduced motion and cancels active movement when it changes', async () => {
    const node = makeNode();
    motion.animateCompanion(node, { arrivalId: 'before-preference' });
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    expect(browserDocument.documentElement.dataset.companionMotion).toBe('quiet');
    motion.animateCompanion(node, { arrivalId: 'during-preference' });
    await Promise.resolve();
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    motion.animateCompanion(node, { arrivalId: 'during-preference' });
    expect(node.animate).toHaveBeenCalledTimes(1);
    motion.animateCompanion(node, { arrivalId: 'after-preference' });
    expect(node.animate).toHaveBeenCalledTimes(2);
  });

  it('caps active animations at two, drops crowded events, and frees capacity after completion', async () => {
    const node = makeNode();
    motion.animateCompanion(node, { arrivalId: 'one' });
    motion.animateCompanion(node, { arrivalId: 'two' });
    motion.animateCompanion(node, { arrivalId: 'crowded' });
    expect(node.animate).toHaveBeenCalledTimes(2);
    animations[0].finish();
    await Promise.resolve();
    motion.animateCompanion(node, { arrivalId: 'crowded' });
    expect(node.animate).toHaveBeenCalledTimes(2);
    motion.animateCompanion(node, { arrivalId: 'four' });
    expect(node.animate).toHaveBeenCalledTimes(3);
  });

  it('avoids timers and loops and emits only finite animation options', () => {
    const node = makeNode();
    motion.animateCompanion(node, { arrivalId: 'arrival' });
    motion.animateCompanion(node, { gesture: { id: 'gesture', kind: 'celebrate' } });
    expect(vi.getTimerCount()).toBe(0);
    for (const [, options] of node.animate.mock.calls) {
      const animationOptions = options as KeyframeAnimationOptions;
      expect(Number(animationOptions.duration)).toBeGreaterThan(0);
      expect(Number(animationOptions.duration)).toBeLessThanOrEqual(1000);
      expect(animationOptions.iterations ?? 1).toBe(1);
    }
  });

  it('ignores absent identities and consumes offscreen or unavailable animations', () => {
    const node = makeNode();
    motion.animateCompanion(node, {});
    motion.animateCompanion(node, { arrivalId: '' });
    motion.animateCompanion(node, { gesture: { id: '', kind: 'wave' } });
    expect(node.animate).not.toHaveBeenCalled();
    const offscreen = makeNode({ width: 40, height: 40, top: 900, left: 10, right: 50, bottom: 940 });
    motion.animateCompanion(offscreen, { arrivalId: 'offscreen' });
    motion.animateCompanion(node, { arrivalId: 'offscreen' });
    expect(offscreen.animate).not.toHaveBeenCalled();
    expect(node.animate).not.toHaveBeenCalled();
    motion.animateCompanion({ ...node, animate: undefined } as unknown as HTMLElement, { arrivalId: 'unsupported' });
    motion.animateCompanion(node, { arrivalId: 'unsupported' });
    expect(node.animate).not.toHaveBeenCalled();
  });

  it('cancels mounted animations on final unsubscribe and resets consumed tokens for a new session', async () => {
    const node = makeNode();
    motion.animateCompanion(node, { arrivalId: 'session-arrival' });
    unsubscribe();
    await Promise.resolve();
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    motion.clearCompanionMotion();
    unsubscribe = motion.subscribeCompanionMotion(() => {});
    motion.animateCompanion(node, { arrivalId: 'session-arrival' });
    expect(node.animate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
