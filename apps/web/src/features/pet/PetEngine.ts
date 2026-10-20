import { gaze, type Gaze, type GazeTarget } from 'blobatar/gaze';
import type { CharacterAppearance } from '@/api';
import { readStored, writeStored } from '@/lib/storage';
import { companionMotionSnapshot, subscribeCompanionMotion } from '@/features/settings/companionMotion';
import {
  boopReaction, chooseActivity, gestureReaction, heldReaction, landingReaction, messageReaction,
  NAP_AFTER_IDLE_MS, pettedReaction, restDelay, welcomeReaction,
  type Activity, type Emote, type Expression, type Mouth, type Reaction,
} from './brain';
import { CONFETTI, EMOTE_MARKUP, ZZZ_MARKUP } from './emotes';
import { BODY_MOTIONS, leapFrames, SIGNATURE_MOTIONS, stepFrames, type Motion } from './motions';
import type { PetPersonality, SignatureMove } from './personality';
import { releaseVelocity, stepFlight, surfaceBelow, type Flight } from './physics';
import { subscribePetSignals, type PetSignal } from './signals';
import { pointOn, preferredPerch, ratioOn, readPerches, type Perch, type PerchKind } from './surfaces';

/**
 * The screen companion's body and nervous system.
 *
 * React draws the creature once and hands over its wrappers; from then on this
 * class moves them directly, so living on screen never re-renders the app.
 * The rules it keeps, in order of importance:
 *
 * - **Nothing runs while nothing happens.** The generator's own idle loops are
 *   switched off; the creature lives in short bursts (a blink, a glance, a
 *   hop) separated by silence, so a creature sitting still asks the browser
 *   for no frames at all.
 * - **Movement is compositor work.** Walks, hops, squash and stretch are Web
 *   Animations on `transform`. The only per-frame JavaScript is a thrown
 *   creature's flight, which ends when it lands and is capped at four seconds.
 * - **Out of sight is off.** When the window loses focus or is hidden every
 *   timer, animation, listener-driven frame and the gaze driver stop; the
 *   creature is a still drawing until you come back. Being away long enough
 *   earns a welcome.
 * - **One timer each.** At most one behaviour timer and one "life" timer are
 *   pending at a time. A creature that has fallen asleep because you left keeps
 *   none at all.
 */
export type PetElements = {
  root: HTMLElement;
  hop: HTMLElement;
  body: HTMLElement;
  hit: HTMLElement;
  shadow: HTMLElement;
  fx: HTMLElement;
  svg: () => SVGSVGElement | null;
};
export type VisitorElements = { root: HTMLElement; body: HTMLElement; fx: HTMLElement; svg: () => SVGSVGElement | null };
export type Visit = {
  id: string;
  userId: string;
  name: string;
  character?: CharacterAppearance;
  gesture: 'wave' | 'nod' | 'celebrate';
};
export type PetHooks = {
  setExpression: (expression: Expression) => void;
  setVisit: (visit: Visit | null) => void;
};

type Task = { controller: AbortController; priority: number };
type Press = { id: number; x: number; y: number; ox: number; oy: number };
type Timer = ReturnType<typeof setTimeout>;

const PRIORITY = { idle: 1, signal: 2, touch: 3 } as const;
const HOME_KEY = 'bc-pet-home';
/** How long falling asleep looks like falling asleep — Zs and breaths — before it is perfectly still. */
const DROWSY_MS = 24_000;
const READING_MS = 15_000;
const DEFAULT_HOME: Record<PerchKind, number> = { composer: 0.94, call: 0.06, canvas: 0.96, floor: 0.97 };
const SIGNATURE_FACE: Record<SignatureMove, [Expression, Mouth]> = {
  flip: ['happy', 'open'], spin: ['happy', 'smile'], melt: ['sleepy', 'o'],
  pogo: ['happy', 'open'], wobble: ['surprised', 'wavy'], tada: ['happy', 'open'],
};

const aborted = () => new DOMException('Aborted', 'AbortError');
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const ease = (frames: Keyframe[]) => frames.map((frame) => ({ easing: 'cubic-bezier(.33,0,.3,1)', ...frame }));

function readHomes(): Record<PerchKind, number> {
  try {
    const stored = JSON.parse(readStored(HOME_KEY) ?? '{}') as Partial<Record<PerchKind, unknown>>;
    const homes = { ...DEFAULT_HOME };
    for (const kind of Object.keys(DEFAULT_HOME) as PerchKind[]) {
      const value = stored[kind];
      if (typeof value === 'number' && Number.isFinite(value)) homes[kind] = clamp(value, 0, 1);
    }
    return homes;
  } catch {
    return { ...DEFAULT_HOME };
  }
}

export class PetEngine {
  private x = 0;
  private y = 0;
  private perch: Perch | undefined;
  private homes = readHomes();
  private task: Task | undefined;
  private readonly animations = new Set<Animation>();
  private readonly timers = new Set<Timer>();
  private readonly cleanups: (() => void)[] = [];
  private behaviorTimer: Timer | undefined;
  private lifeTimer: Timer | undefined;
  private refreshTimer: Timer | undefined;
  private lookTimer: Timer | undefined;
  private composeTimer: Timer | undefined;
  private raf = 0;
  private eyes: Gaze | undefined;
  private lookUntil = 0;
  private pointerNear = false;
  private readonly followRadius: number;
  private perchObserver: ResizeObserver | undefined;
  private reducedQuery: MediaQueryList | undefined;
  private started = false;
  private frozen = false;
  private frozenAt = 0;
  private pending: { weight: number; reaction: Reaction } | undefined;
  private reduced = false;
  private quiet = false;
  private asleep: 'idle' | 'tired' | undefined;
  private asleepSince = 0;
  private napUntil = 0;
  private awakeSince = performance.now();
  private lastInput = performance.now();
  private lastActivity: Activity | undefined;
  private lastMessageAt = 0;
  private lastFriendAt = 0;
  private readonly typingSeen = new Set<string>();
  private boops: number[] = [];
  private lastClick = 0;
  private petting = { dir: 0, flips: 0, since: 0 };
  private petCooldown = 0;
  private press: Press | undefined;
  private holding = false;
  private flying = false;
  private swing = 0;
  private samples: { x: number; y: number; t: number }[] = [];
  private settleUntil = 0;
  private visiting = false;
  private visitorWaiter: ((elements: VisitorElements) => void) | undefined;
  private expression: Expression = 'idle';

  constructor(
    private readonly el: PetElements,
    private readonly personality: PetPersonality,
    private readonly size: number,
    private readonly hooks: PetHooks,
    private readonly self: string,
  ) {
    this.followRadius = 140 + personality.curiosity * 420 + personality.affection * 160 - personality.shyness * 120;
  }

  start(entrance: boolean) {
    if (this.started) return;
    this.started = true;
    this.reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced = this.reducedQuery.matches;
    this.quiet = companionMotionSnapshot().preference === 'quiet';
    const on = <K extends string>(target: EventTarget, type: K, listener: (event: never) => void, options?: AddEventListenerOptions) => {
      target.addEventListener(type, listener as EventListener, options);
      this.cleanups.push(() => target.removeEventListener(type, listener as EventListener, options));
    };
    on(window, 'focus', this.onAttention);
    on(window, 'blur', this.onAttention);
    on(document, 'visibilitychange', this.onAttention);
    on(document, 'fullscreenchange', this.onAttention);
    on(window, 'pointermove', this.onPointerMove, { passive: true });
    on(window, 'pointerdown', this.onInput, { passive: true, capture: true });
    on(window, 'wheel', this.onInput, { passive: true });
    on(window, 'keydown', this.onKey, { capture: true });
    on(window, 'resize', this.onLayout);
    on(document, 'focusin', this.onLayout);
    on(window, 'click', this.onLayout, { capture: true });
    on(this.reducedQuery, 'change', this.onMotionPreference);
    on(this.el.hit, 'pointerdown', this.onHitDown);
    on(this.el.hit, 'pointermove', this.onHitMove);
    on(this.el.hit, 'pointerup', this.onHitUp);
    on(this.el.hit, 'pointercancel', this.onHitCancel);
    on(this.el.hit, 'pointerenter', this.onHitEnter);
    on(this.el.hit, 'pointerleave', this.onHitLeave);
    on(this.el.hit, 'dragstart', (event: DragEvent) => event.preventDefault());
    this.cleanups.push(subscribePetSignals(this.onSignal));
    this.cleanups.push(subscribeCompanionMotion(this.onMotionPreference));

    this.frozen = !this.attentive();
    this.syncFlags();
    const perch = this.choosePerch();
    this.adopt(perch);
    const x = pointOn(perch.surface, this.homes[perch.kind]);
    this.place(x, perch.surface.y);
    this.el.root.dataset.ready = 'true';
    if (this.frozen) return;
    this.attachEyes();
    if (entrance && this.canMove()) this.runTask(PRIORITY.signal, (signal) => this.enter(signal));
    else this.scheduleBehavior();
    this.scheduleLife();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.task?.controller.abort();
    this.task = undefined;
    this.cancelAnimations();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const timer of [this.behaviorTimer, this.lifeTimer, this.refreshTimer, this.lookTimer, this.composeTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.eyes?.stop();
    this.eyes = undefined;
    this.perchObserver?.disconnect();
    this.perchObserver = undefined;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.el.fx.replaceChildren();
    this.visitorWaiter = undefined;
    // Leave the DOM as React rendered it, so a successor engine on the same
    // nodes (a new size, a new character, Strict Mode's rehearsal) starts clean.
    const root = this.el.root.dataset;
    for (const key of ['ready', 'expr', 'mouth', 'blush', 'blink', 'asleep', 'talking', 'held', 'airborne', 'hover', 'frozen', 'still', 'hidden']) delete root[key];
    for (const element of [this.el.root, this.el.hop, this.el.body]) {
      element.style.removeProperty('transform');
      element.style.removeProperty('transform-origin');
    }
  }

  /** React calls this when the visitor it was asked to draw has mounted. */
  setVisitorElements(elements: VisitorElements | null) {
    if (!elements || !this.visitorWaiter) return;
    const waiter = this.visitorWaiter;
    this.visitorWaiter = undefined;
    waiter(elements);
  }

  // ---------------------------------------------------------------- state

  private attentive() {
    return !document.hidden && document.hasFocus() && !document.fullscreenElement;
  }

  private canMove() {
    return !this.reduced && !this.quiet;
  }

  private syncFlags() {
    const root = this.el.root.dataset;
    root.frozen = String(this.frozen);
    root.still = String(!this.canMove());
    if (document.fullscreenElement) root.hidden = 'true';
    else delete root.hidden;
  }

  private onMotionPreference = () => {
    const reduced = this.reducedQuery?.matches ?? false;
    const quiet = companionMotionSnapshot().preference === 'quiet';
    if (reduced === this.reduced && quiet === this.quiet) return;
    this.reduced = reduced;
    this.quiet = quiet;
    this.syncFlags();
    if (!this.canMove()) {
      if (this.holding) this.endHold();
      if (this.flying) this.endFlight(undefined, 0);
      this.abortTask();
      this.cancelAnimations();
      this.el.fx.replaceChildren();
      delete this.el.root.dataset.blink;
      this.relax();
      this.settle();
    }
    if (!this.canMove()) {
      this.eyes?.stop();
      this.eyes = undefined;
    } else if (!this.frozen) this.attachEyes();
    this.scheduleLife();
  };

  private onAttention = () => {
    this.syncFlags();
    const attentive = this.attentive();
    if (!attentive && !this.frozen) this.freeze();
    else if (attentive && this.frozen) this.thaw();
  };

  private freeze() {
    this.frozen = true;
    this.frozenAt = performance.now();
    this.syncFlags();
    if (this.holding) this.endHold();
    if (this.flying) this.endFlight(undefined, 0);
    this.abortTask();
    this.cancelAnimations();
    for (const timer of [this.behaviorTimer, this.lifeTimer, this.refreshTimer, this.lookTimer, this.composeTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.behaviorTimer = this.lifeTimer = this.refreshTimer = this.lookTimer = this.composeTimer = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.el.fx.replaceChildren();
    this.eyes?.stop();
    this.eyes = undefined;
    delete this.el.root.dataset.blink;
    if (!this.asleep) this.relax();
    delete this.el.root.dataset.talking;
  }

  private thaw() {
    this.frozen = false;
    this.syncFlags();
    const away = performance.now() - this.frozenAt;
    this.lastInput = performance.now();
    this.attachEyes();
    this.refreshPerch();
    const pending = this.pending;
    this.pending = undefined;
    if (this.asleep) this.wake(pending ? 'signal' : 'input');
    if (pending) this.runTask(PRIORITY.signal, (signal) => this.perform(pending.reaction, signal));
    else if (away > 3 * 60_000 && !this.task) this.runTask(PRIORITY.signal, (signal) => this.perform(welcomeReaction(this.personality, away), signal));
    this.scheduleBehavior();
    this.scheduleLife();
  }

  // ---------------------------------------------------------------- tasks

  /**
   * One thing at a time. A new task replaces the current one unless the
   * current one matters more: a pet being held ignores a message arriving.
   */
  private runTask(priority: number, work: (signal: AbortSignal) => Promise<void>) {
    if (!this.started || this.frozen) return false;
    if (this.task && this.task.priority > priority) return false;
    if (this.task) {
      // An interrupted reaction must not leave its face behind on whatever comes next.
      this.task.controller.abort();
      this.relax();
    }
    const controller = new AbortController();
    const task = { controller, priority };
    this.task = task;
    if (this.behaviorTimer !== undefined) clearTimeout(this.behaviorTimer);
    this.behaviorTimer = undefined;
    void work(controller.signal)
      .catch((error: unknown) => {
        if (!isAbort(error)) throw error;
      })
      .finally(() => {
        if (this.task !== task) return;
        this.task = undefined;
        if (this.started && !this.frozen) this.scheduleBehavior();
      });
    return true;
  }

  /** Stops whatever it was doing; the behaviour loop picks up again unless something else takes over. */
  private abortTask() {
    if (!this.task) return;
    this.task.controller.abort();
    this.task = undefined;
    this.relax();
    this.scheduleBehavior();
  }

  private animate(element: Element, frames: Keyframe[], options: KeyframeAnimationOptions, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(aborted());
    const animation = element.animate(frames, options);
    this.animations.add(animation);
    const cancel = () => animation.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    return animation.finished.then(
      () => undefined,
      () => {
        throw aborted();
      },
    ).finally(() => {
      this.animations.delete(animation);
      signal.removeEventListener('abort', cancel);
    });
  }

  private cancelAnimations() {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
  }

  private wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(aborted());
        return;
      }
      const timer = this.later(ms, () => {
        signal.removeEventListener('abort', stop);
        resolve();
      });
      const stop = () => {
        clearTimeout(timer);
        this.timers.delete(timer);
        reject(aborted());
      };
      signal.addEventListener('abort', stop, { once: true });
    });
  }

  private later(ms: number, callback: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  // ---------------------------------------------------------------- position

  private translate(x: number, y: number, size = this.size) {
    return `translate3d(${(x - size / 2).toFixed(1)}px, ${(y - size).toFixed(1)}px, 0)`;
  }

  private place(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.el.root.style.transform = this.translate(x, y);
  }

  /** Where the root really is, mid-animation, read once when something interrupts it. */
  private readPosition() {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(this.el.root).transform);
    return { x: matrix.m41 + this.size / 2, y: matrix.m42 + this.size };
  }

  /**
   * Moves the root along `frames` to `to`. The final position is written
   * first, so cancelling an animation leaves the creature where it was headed;
   * an interruption reads the real position back so it stops where it is.
   */
  private travel(frames: Keyframe[], to: { x: number; y: number }, options: KeyframeAnimationOptions, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(aborted());
    const root = this.el.root;
    const freezeHere = () => {
      const position = this.readPosition();
      this.place(position.x, position.y);
    };
    signal.addEventListener('abort', freezeHere, { once: true });
    this.place(to.x, to.y);
    return this.animate(root, frames, options, signal).finally(() => signal.removeEventListener('abort', freezeHere));
  }

  private bodyMotion(motion: Motion, signal: AbortSignal, body = this.el.body, shadow: HTMLElement | undefined = this.el.shadow) {
    const options = { duration: motion.duration, easing: motion.easing ?? 'linear' };
    return Promise.all([
      this.animate(body, ease(motion.frames), options, signal),
      motion.shadow && shadow ? this.animate(shadow, motion.shadow, options, signal) : undefined,
    ]).then(() => undefined);
  }

  private async walkTo(targetX: number, signal: AbortSignal) {
    const distance = Math.abs(targetX - this.x);
    if (distance < 6) return;
    const direction = Math.sign(targetX - this.x);
    const stride = this.size * (0.3 + this.personality.energy * 0.24);
    const steps = Math.max(1, Math.round(distance / stride));
    const stepMs = this.personality.stepMs;
    const lean = direction * (4 + this.personality.energy * 6);
    const step = stepFrames(this.size * this.personality.hop);
    const startX = this.x;
    const y = this.y;
    const root: Keyframe[] = [];
    for (let index = 0; index < steps; index += 1) {
      root.push({ offset: index / steps, transform: this.translate(startX + ((targetX - startX) * index) / steps, y), easing: 'cubic-bezier(.4,0,.5,1)' });
      root.push({ offset: (index + 0.88) / steps, transform: this.translate(startX + ((targetX - startX) * (index + 1)) / steps, y) });
    }
    root.push({ offset: 1, transform: this.translate(targetX, y) });
    this.look({ x: targetX + direction * 240, y: y - this.size * 0.8 }, steps * stepMs + 300);
    await Promise.all([
      this.travel(root, { x: targetX, y }, { duration: steps * stepMs }, signal),
      this.animate(this.el.hop, step.hop, { duration: stepMs, iterations: steps }, signal),
      this.animate(this.el.body, step.body.map((frame) => ({ ...frame, transform: `skewX(${-lean}deg) ${frame.transform}` })), { duration: stepMs, iterations: steps }, signal),
    ]);
    await this.bodyMotion({ duration: 300, frames: [{ transform: `skewX(${-lean}deg) scale(1.1,.9)` }, { transform: `skewX(${lean * 0.3}deg) scale(.97,1.03)`, offset: 0.55 }, { transform: 'none' }] }, signal);
    this.look(null);
  }

  private async leapTo(x: number, y: number, signal: AbortSignal) {
    const dx = x - this.x;
    const dy = y - this.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 4) {
      this.place(x, y);
      return;
    }
    const duration = Math.min(1150, 540 + distance * 0.5);
    const height = this.size * 0.8 + Math.max(0, -dy) * 0.3 + Math.min(Math.abs(dx), 500) * 0.1;
    const frames = leapFrames(height);
    const from = this.translate(this.x, this.y);
    const to = this.translate(x, y);
    // A shadow on a different floor than the one it left reads as a ghost; let it fade across.
    const shadow = Math.abs(dy) > 8
      ? [{ opacity: 1, offset: 0 }, { opacity: 0, offset: 0.2 }, { opacity: 0, offset: 0.8 }, { opacity: 1, offset: 1 }]
      : frames.shadow;
    this.look({ x, y: y - this.size }, duration);
    await Promise.all([
      this.travel([
        { offset: 0, transform: from },
        { offset: 0.14, transform: from, easing: 'cubic-bezier(.3,.3,.6,1)' },
        { offset: 0.88, transform: to },
        { offset: 1, transform: to },
      ], { x, y }, { duration }, signal),
      this.animate(this.el.hop, frames.hop, { duration }, signal),
      this.animate(this.el.body, frames.body, { duration }, signal),
      this.animate(this.el.shadow, shadow, { duration }, signal),
    ]);
    this.look(null);
  }

  private async enter(signal: AbortSignal) {
    const { x, y } = this;
    this.setFace('surprised', 'o', false);
    await Promise.all([
      this.travel([{ transform: this.translate(x, -this.size * 0.2) }, { transform: this.translate(x, y) }], { x, y }, { duration: 640, easing: 'cubic-bezier(.55,0,1,.45)' }, signal),
      this.animate(this.el.body, [{ transform: 'scale(.86,1.18)' }, { transform: 'scale(.9,1.14)' }], { duration: 640 }, signal),
      this.animate(this.el.shadow, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 640, easing: 'ease-in' }, signal),
    ]);
    this.setFace('happy', 'open', false);
    this.emote('sparkle');
    await this.bodyMotion(BODY_MOTIONS.land, signal);
    await this.wait(700, signal);
    this.relax();
  }

  // ---------------------------------------------------------------- perches

  private choosePerch() {
    return preferredPerch(readPerches(this.size), document.activeElement);
  }

  private adopt(perch: Perch) {
    const previous = this.perch?.element;
    this.perch = perch;
    if (previous === perch.element) return;
    this.perchObserver?.disconnect();
    this.perchObserver = undefined;
    if (!perch.element || typeof ResizeObserver === 'undefined') return;
    this.perchObserver = new ResizeObserver(() => this.scheduleRefresh(60));
    this.perchObserver.observe(perch.element);
  }

  private onLayout = (event: Event) => this.scheduleRefresh(event.type === 'resize' ? 150 : 220);

  private scheduleRefresh(ms: number) {
    if (this.frozen || !this.started) return;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshPerch();
    }, ms);
  }

  /**
   * Follows the screen. Navigation, focus and resizes move or replace the
   * perch; the creature hops to wherever you are now working.
   */
  private refreshPerch() {
    if (this.frozen || this.holding || this.flying || this.visiting || !this.started) return;
    const perches = readPerches(this.size);
    const current = this.perch && perches.find((perch) => perch.key === this.perch!.key);
    const preferred = performance.now() < this.settleUntil && current ? current : preferredPerch(perches, document.activeElement);
    const moving = this.task && this.task.priority >= PRIORITY.signal;
    if (current && preferred.key === current.key) {
      const surface = current.surface;
      const x = clamp(this.x, surface.left, surface.right);
      this.adopt(current);
      if (Math.abs(surface.y - this.y) < 0.5 && x === this.x) return;
      if (moving) return;
      if (this.task) this.abortTask();
      if (Math.abs(surface.y - this.y) > 14 && this.canMove()) this.runTask(PRIORITY.signal, (signal) => this.leapTo(x, surface.y, signal));
      else this.place(x, surface.y);
      return;
    }
    this.adopt(preferred);
    const x = pointOn(preferred.surface, this.homes[preferred.kind]);
    if (!this.canMove()) {
      this.abortTask();
      this.place(x, preferred.surface.y);
      return;
    }
    this.runTask(PRIORITY.signal, (signal) => this.leapTo(x, preferred.surface.y, signal));
  }

  /** Drops onto whatever is below without flying, for reduced motion and interruptions. */
  private settle() {
    const perches = readPerches(this.size);
    const surface = surfaceBelow(this.x, this.y - 1, perches.map((perch) => perch.surface)) ?? perches[perches.length - 1].surface;
    const perch = perches.find((candidate) => candidate.key === surface.key) ?? perches[perches.length - 1];
    this.adopt(perch);
    this.place(clamp(this.x, surface.left, surface.right), surface.y);
  }

  private rememberHome(perch: Perch) {
    this.homes = { ...this.homes, [perch.kind]: ratioOn(perch.surface, this.x) };
    writeStored(HOME_KEY, JSON.stringify(this.homes));
  }

  // ---------------------------------------------------------------- face

  private setFace(expression: Expression, mouth: Mouth = 'none', blush = false) {
    if (expression !== this.expression) {
      this.expression = expression;
      this.hooks.setExpression(expression);
    }
    const root = this.el.root.dataset;
    root.expr = expression;
    root.mouth = mouth;
    root.blush = String(blush);
  }

  private relax() {
    if (this.asleep) {
      this.setFace('sleepy');
      return;
    }
    this.setFace('idle');
  }

  private blink() {
    const root = this.el.root.dataset;
    if (this.asleep || root.blink) return;
    root.blink = 'true';
    this.later(200, () => {
      delete root.blink;
    });
  }

  private emote(kind: Emote, host = this.el.fx) {
    while (host.childElementCount >= 4) host.firstElementChild?.remove();
    const mark = document.createElement('span');
    mark.className = `pet-emote pet-emote-${kind}`;
    mark.setAttribute('aria-hidden', 'true');
    if (kind === 'confetti') {
      for (const piece of CONFETTI) {
        const bit = document.createElement('i');
        bit.style.cssText = `--dx:${piece.dx}px;--dy:${piece.dy}px;--r:${piece.r}deg;--c:${piece.hue}`;
        mark.append(bit);
      }
    } else mark.innerHTML = kind === 'zzz' ? ZZZ_MARKUP : EMOTE_MARKUP[kind];
    const remove = () => mark.remove();
    mark.addEventListener('animationend', (event) => {
      if (event.target === mark) remove();
    });
    host.append(mark);
    this.later(2600, remove);
  }

  // ---------------------------------------------------------------- eyes

  private attachEyes() {
    if (this.eyes || !this.canMove() || this.frozen) return;
    const svg = this.el.svg();
    if (!svg) return;
    this.eyes = gaze(svg, { target: this.defaultGaze() });
  }

  private defaultGaze(): GazeTarget {
    if (this.asleep) return 'rest';
    return this.pointerNear ? 'pointer' : null;
  }

  /**
   * Looks at something for a while, then goes back to watching you or minding
   * its own business. Every look has an end, so an interrupted walk can never
   * leave the eyes fixed on a point nobody cares about.
   */
  private look(target: GazeTarget | null, ms = 1500) {
    if (!this.eyes) return;
    if (this.lookTimer !== undefined) clearTimeout(this.lookTimer);
    this.lookTimer = undefined;
    if (target === null) {
      this.lookUntil = 0;
      this.eyes.lookAt(this.defaultGaze());
      return;
    }
    this.eyes.lookAt(target);
    this.lookUntil = performance.now() + ms;
    this.lookTimer = setTimeout(() => {
      this.lookTimer = undefined;
      this.lookUntil = 0;
      this.eyes?.lookAt(this.defaultGaze());
    }, ms);
  }

  private remeasureEyes() {
    this.eyes?.remeasure();
  }

  // ---------------------------------------------------------------- life

  private scheduleLife() {
    if (this.lifeTimer !== undefined) clearTimeout(this.lifeTimer);
    this.lifeTimer = undefined;
    if (this.frozen || !this.canMove() || !this.started) return;
    const asleepFor = performance.now() - this.asleepSince;
    // Deep sleep is perfectly still: no Zs, no breaths, no timer.
    if (this.asleep && asleepFor > DROWSY_MS) return;
    const delay = this.asleep ? 4200 : 2300 + Math.random() * 4300;
    this.lifeTimer = setTimeout(this.lifeBeat, delay);
  }

  private lifeBeat = () => {
    this.lifeTimer = undefined;
    if (this.frozen || !this.canMove() || !this.started) return;
    if (this.asleep) {
      this.emote('zzz');
      if (!this.task) this.breathe(2600, 0.035);
    } else if (!this.holding && !this.flying) {
      const roll = Math.random();
      this.blink();
      if (roll > 0.62 && roll < 0.8) this.later(260, () => this.blink());
      else if (roll >= 0.8 && !this.task) this.breathe(1500, 0.02);
    }
    this.scheduleLife();
  };

  private breathe(duration: number, depth: number) {
    if (this.frozen || !this.canMove() || !this.started) return;
    const animation = this.el.body.animate([
      { transform: 'none' },
      { transform: `scale(${1 + depth},${1 - depth})`, offset: 0.5 },
      { transform: 'none' },
    ], { duration, easing: 'ease-in-out' });
    this.animations.add(animation);
    const done = () => this.animations.delete(animation);
    animation.finished.then(done, done);
  }

  /** Reading, not interacting: it settles down rather than performing for nobody. */
  private reading() {
    return performance.now() - this.lastInput > READING_MS;
  }

  private scheduleBehavior(delay = restDelay(this.personality) * (this.reading() ? 2 : 1)) {
    if (this.behaviorTimer !== undefined) clearTimeout(this.behaviorTimer);
    this.behaviorTimer = undefined;
    if (this.frozen || !this.started || this.asleep === 'idle') return;
    if (this.asleep === 'tired') delay = Math.max(400, this.napUntil - performance.now());
    this.behaviorTimer = setTimeout(this.tick, delay);
  }

  private tick = () => {
    this.behaviorTimer = undefined;
    if (this.frozen || this.holding || this.flying || !this.started) return;
    if (this.task) {
      this.scheduleBehavior(1600);
      return;
    }
    if (this.asleep) {
      if (performance.now() < this.napUntil) this.scheduleBehavior();
      // Nobody to wake up for: a nap turns into sleeping until you are back, silently.
      else if (performance.now() - this.lastInput > NAP_AFTER_IDLE_MS) {
        this.asleep = 'idle';
        this.napUntil = Infinity;
      } else this.wake('rested');
      return;
    }
    this.refreshPerch();
    if (this.task) return;
    const now = performance.now();
    if (now - this.lastInput > NAP_AFTER_IDLE_MS) {
      this.sleep('idle');
      return;
    }
    const activity = chooseActivity(this.personality, {
      hour: new Date().getHours(),
      awakeMs: now - this.awakeSince,
      surfaces: 1,
      last: this.lastActivity,
      quiet: !this.canMove() || this.reading(),
    });
    this.lastActivity = activity;
    if (activity === 'nap') {
      this.sleep('tired');
      return;
    }
    this.runTask(PRIORITY.idle, (signal) => this.activity(activity, signal));
  };

  private async activity(activity: Exclude<Activity, 'nap'>, signal: AbortSignal) {
    const p = this.personality;
    switch (activity) {
      case 'sit':
        await this.wait(800 + Math.random() * 1600, signal);
        return;
      case 'glance': {
        this.look(this.glanceTarget(), 1300 + Math.random() * 1500);
        if (p.curiosity > 0.6 && Math.random() < 0.3) this.emote('question');
        await this.wait(1600, signal);
        return;
      }
      case 'wander':
        await this.walkTo(this.wanderTarget(), signal);
        return;
      case 'signature':
        await this.signature(signal);
        return;
      case 'stretch':
        this.setFace('sleepy', 'open');
        await this.bodyMotion(BODY_MOTIONS.stretch, signal);
        this.relax();
        return;
      case 'explore': {
        const surface = this.perch?.surface;
        if (!surface) return;
        const room = surface.right - surface.left;
        const direction = this.x - surface.left > room / 2 ? -1 : 1;
        const x = clamp(this.x + direction * this.size * (2.2 + Math.random() * 3), surface.left, surface.right);
        await this.leapTo(x, surface.y, signal);
        this.look({ x: x - direction * 400, y: this.y - 300 }, 900);
        await this.wait(1100, signal);
        this.look({ x: x + direction * 400, y: this.y - 200 }, 900);
        await this.wait(1000, signal);
        return;
      }
      case 'hum':
        this.setFace('happy', 'smile');
        this.emote('note');
        this.later(900, () => {
          if (!signal.aborted) this.emote('note');
        });
        if (this.canMove()) await this.bodyMotion(BODY_MOTIONS.sway, signal);
        else await this.wait(2000, signal);
        this.relax();
        return;
    }
  }

  private glanceTarget(): GazeTarget {
    const options: GazeTarget[] = [
      { x: this.x - 280 - Math.random() * 360, y: this.y - 220 - Math.random() * 260 },
      { x: 24, y: window.innerHeight * (0.25 + Math.random() * 0.5) },
      { x: this.x + 160, y: this.y - 120 },
      { x: this.x, y: 0 },
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  private wanderTarget() {
    const surface = this.perch?.surface;
    if (!surface) return this.x;
    const home = pointOn(surface, this.homes[this.perch!.kind]);
    if (Math.abs(this.x - home) > this.size * 2.2) return clamp(home + (Math.random() - 0.5) * this.size * 0.6, surface.left, surface.right);
    const reach = this.size * (0.9 + this.personality.energy * 2.6);
    return clamp(home + (Math.random() * 2 - 1) * reach, surface.left, surface.right);
  }

  private async signature(signal: AbortSignal) {
    const move = this.personality.signature;
    const [expression, mouth] = SIGNATURE_FACE[move];
    this.setFace(expression, mouth);
    const motion = SIGNATURE_MOTIONS[move];
    if (move === 'tada') this.later(motion.duration * 0.45, () => !signal.aborted && this.emote('confetti'));
    if (move === 'melt') this.later(motion.duration * 0.3, () => !signal.aborted && this.emote('sweat'));
    await this.bodyMotion(motion, signal);
    if (move === 'flip' || move === 'pogo' || move === 'spin') this.emote('sparkle');
    await this.wait(550, signal);
    this.relax();
  }

  private async perform(reaction: Reaction, signal: AbortSignal) {
    this.setFace(reaction.expression, reaction.mouth ?? 'none', reaction.blush ?? false);
    if (reaction.emote) this.emote(reaction.emote);
    const started = performance.now();
    if (reaction.motion && this.canMove()) await this.bodyMotion(BODY_MOTIONS[reaction.motion], signal);
    const left = reaction.hold - (performance.now() - started);
    if (left > 0) await this.wait(left, signal);
    this.relax();
  }

  private sleep(reason: 'idle' | 'tired') {
    this.abortTask();
    this.asleep = reason;
    this.asleepSince = performance.now();
    this.napUntil = reason === 'tired' ? this.asleepSince + 9000 + Math.random() * 16_000 : Infinity;
    this.setFace('sleepy');
    this.look(null);
    this.later(900, () => {
      if (this.asleep) this.el.root.dataset.asleep = 'true';
    });
    this.emote('zzz');
    this.scheduleLife();
    this.scheduleBehavior();
  }

  private wake(cause: 'input' | 'rested' | 'signal' | 'touch') {
    if (!this.asleep) return;
    this.asleep = undefined;
    this.awakeSince = performance.now();
    delete this.el.root.dataset.asleep;
    this.el.fx.querySelectorAll('.pet-emote-zzz').forEach((mark) => mark.remove());
    this.eyes?.lookAt(this.defaultGaze());
    this.scheduleLife();
    if (cause === 'signal' || cause === 'touch') {
      this.relax();
      return;
    }
    this.runTask(PRIORITY.signal, async (signal) => {
      this.setFace('sleepy', 'open');
      if (this.canMove()) await this.bodyMotion(BODY_MOTIONS.stretch, signal);
      else await this.wait(1200, signal);
      this.relax();
    });
  }

  // ---------------------------------------------------------------- input

  private onInput = () => {
    this.lastInput = performance.now();
    if (this.asleep === 'idle' && !this.frozen) this.wake('input');
  };

  private onKey = (event: KeyboardEvent) => {
    this.onInput();
    if (event.key === 'Escape' || event.key === 'Enter') this.scheduleRefresh(220);
    const target = event.target as Element | null;
    if (!target || this.frozen || !target.closest?.('[data-pet-perch="composer"] textarea')) return;
    // Watches you write, then goes back to its own business once you stop.
    if (this.composeTimer === undefined) this.look(target, 60_000);
    else clearTimeout(this.composeTimer);
    this.composeTimer = setTimeout(() => {
      this.composeTimer = undefined;
      this.look(null);
    }, 1400);
  };

  private onPointerMove = (event: PointerEvent) => {
    this.lastInput = performance.now();
    if (this.asleep === 'idle' && !this.frozen) this.wake('input');
    if (!this.eyes || this.holding) return;
    const distance = Math.hypot(event.clientX - this.x, event.clientY - (this.y - this.size / 2));
    const near = this.pointerNear ? distance < this.followRadius * 1.25 : distance < this.followRadius;
    if (near === this.pointerNear) return;
    this.pointerNear = near;
    if (performance.now() >= this.lookUntil) this.eyes.lookAt(this.defaultGaze());
  };

  private onHitEnter = () => {
    this.el.root.dataset.hover = 'true';
  };

  private onHitLeave = () => {
    delete this.el.root.dataset.hover;
    this.petting.flips = 0;
  };

  private onHitDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.frozen) return;
    event.preventDefault();
    this.el.hit.setPointerCapture(event.pointerId);
    this.press = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: event.clientX - this.x, oy: event.clientY - this.y };
    this.samples = [{ x: event.clientX, y: event.clientY, t: event.timeStamp }];
  };

  private onHitMove = (event: PointerEvent) => {
    const press = this.press;
    if (press && event.pointerId === press.id) {
      this.samples.push({ x: event.clientX, y: event.clientY, t: event.timeStamp });
      if (this.samples.length > 10) this.samples.shift();
      if (!this.holding && this.canMove() && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) this.beginHold();
      if (this.holding) this.followHold(event, press);
      return;
    }
    if (!press && event.pointerType === 'mouse') this.detectPetting(event);
  };

  private onHitUp = (event: PointerEvent) => {
    const press = this.press;
    if (!press || event.pointerId !== press.id) return;
    this.press = undefined;
    if (this.holding) this.release(releaseVelocity(this.samples));
    else this.click();
  };

  private onHitCancel = (event: PointerEvent) => {
    if (!this.press || event.pointerId !== this.press.id) return;
    this.press = undefined;
    if (this.holding) this.release({ vx: 0, vy: 0 });
  };

  private click() {
    const now = performance.now();
    if (this.asleep) {
      this.wake('touch');
      this.runTask(PRIORITY.touch, (signal) => this.perform({ expression: 'surprised', emote: 'exclaim', motion: 'perk', mouth: 'o', hold: 900 }, signal));
      return;
    }
    if (now - this.lastClick < 340 && this.canMove()) {
      this.lastClick = 0;
      this.boops = [];
      this.runTask(PRIORITY.touch, (signal) => this.signature(signal));
      return;
    }
    this.lastClick = now;
    this.boops = this.boops.filter((time) => now - time < 2600);
    this.boops.push(now);
    const reaction = boopReaction(this.personality, this.boops.length);
    if (this.boops.length >= 5) this.boops = [];
    this.runTask(PRIORITY.touch, (signal) => this.perform(reaction, signal));
  }

  /** Back-and-forth strokes across the creature, like scratching behind an ear that isn't there. */
  private detectPetting(event: PointerEvent) {
    const direction = Math.sign(event.movementX);
    if (!direction || Math.abs(event.movementX) < 2) return;
    const now = event.timeStamp;
    if (now - this.petting.since > 1600) this.petting = { dir: direction, flips: 0, since: now };
    else if (direction !== this.petting.dir) {
      this.petting.dir = direction;
      this.petting.flips += 1;
    }
    if (this.petting.flips < 4 || now < this.petCooldown) return;
    this.petCooldown = now + 3000;
    this.petting.flips = 0;
    if (this.asleep) {
      this.emote('heart');
      this.el.root.dataset.blush = 'true';
      this.later(1800, () => {
        if (this.asleep) this.el.root.dataset.blush = 'false';
      });
      return;
    }
    this.runTask(PRIORITY.touch, (signal) => this.perform(pettedReaction(this.personality), signal));
  }

  private beginHold() {
    if (this.asleep) this.wake('touch');
    this.abortTask();
    this.cancelAnimations();
    this.holding = true;
    this.swing = 0;
    this.el.root.dataset.held = 'true';
    this.el.body.style.transformOrigin = '50% 30%';
    const face = heldReaction(this.personality);
    this.setFace(face.expression, face.mouth, face.blush);
    if (face.emote) this.emote(face.emote);
    if (this.behaviorTimer !== undefined) clearTimeout(this.behaviorTimer);
    this.behaviorTimer = undefined;
  }

  private followHold(event: PointerEvent, press: Press) {
    const half = this.size / 2;
    const x = clamp(event.clientX - press.ox, half, window.innerWidth - half);
    const y = clamp(event.clientY - press.oy, this.size, window.innerHeight);
    const previous = this.samples[this.samples.length - 2];
    const last = this.samples[this.samples.length - 1];
    const velocity = previous && last && last.t > previous.t ? (last.x - previous.x) / (last.t - previous.t) : 0;
    this.swing += (clamp(-velocity * 16, -28, 28) - this.swing) * 0.35;
    this.el.body.style.transform = `rotate(${this.swing.toFixed(1)}deg) scale(.93,1.09)`;
    this.place(x, y);
  }

  private endHold() {
    this.holding = false;
    this.press = undefined;
    delete this.el.root.dataset.held;
    this.el.body.style.transform = '';
    this.el.body.style.transformOrigin = '';
  }

  private release(velocity: { vx: number; vy: number }) {
    this.endHold();
    if (!this.canMove() || this.frozen) {
      this.settle();
      this.landed(0);
      return;
    }
    this.fly(velocity);
  }

  private fly(velocity: { vx: number; vy: number }) {
    const perches = readPerches(this.size);
    const surfaces = perches.map((perch) => perch.surface);
    const half = this.size / 2;
    const arena = { left: half + 4, right: window.innerWidth - half - 4, top: this.size + 4 };
    let flight: Flight = { x: this.x, y: this.y, vx: velocity.vx, vy: velocity.vy, bounces: 0 };
    let last = performance.now();
    const started = last;
    let peak = Math.hypot(velocity.vx, velocity.vy);
    this.flying = true;
    this.el.root.dataset.airborne = 'true';
    this.setFace(peak > 1400 ? 'scared' : 'surprised', 'o');
    const frame = (now: number) => {
      this.raf = 0;
      const step = stepFlight(flight, (now - last) / 1000, arena, surfaces);
      last = now;
      flight = step.flight;
      peak = Math.max(peak, step.speed);
      this.place(flight.x, flight.y);
      const stretch = Math.min(0.2, Math.abs(flight.vy) / 6000);
      this.el.body.style.transform = `scale(${(1 - stretch * 0.6).toFixed(3)},${(1 + stretch).toFixed(3)})`;
      if (step.impact === 'wall' || step.impact === 'bounce') {
        const animation = this.el.body.animate([{ transform: step.impact === 'wall' ? 'scale(.78,1.12)' : 'scale(1.3,.7)' }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
        this.animations.add(animation);
        const done = () => this.animations.delete(animation);
        void animation.finished.then(done, done);
      }
      if (step.landed || now - started > 4000) {
        const surface = step.landed ?? surfaceBelow(flight.x, flight.y - 1, surfaces) ?? surfaces[surfaces.length - 1];
        this.endFlight(perches.find((perch) => perch.key === surface.key), peak);
        return;
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private endFlight(perch: Perch | undefined, peak: number) {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.flying = false;
    delete this.el.root.dataset.airborne;
    this.el.body.style.transform = '';
    if (perch) {
      this.adopt(perch);
      this.place(clamp(this.x, perch.surface.left, perch.surface.right), perch.surface.y);
    } else this.settle();
    if (!this.frozen) this.landed(peak);
  }

  private landed(speed: number) {
    const perch = this.perch;
    if (perch) {
      this.rememberHome(perch);
      if (perch.kind === 'floor' || perch.key !== this.choosePerch().key) this.settleUntil = performance.now() + 9000;
    }
    this.remeasureEyes();
    this.runTask(PRIORITY.touch, (signal) => this.perform(landingReaction(this.personality, speed), signal));
  }

  // ---------------------------------------------------------------- signals

  private here(roomId: string) {
    return this.perch?.kind === 'composer' && this.perch.room === roomId;
  }

  /** While away, only the most important thing that happened is kept for your return. */
  private hold(weight: number, reaction: Reaction) {
    if (!this.pending || this.pending.weight <= weight) this.pending = { weight, reaction };
  }

  private onSignal = (signal: PetSignal) => {
    if (!this.started) return;
    const p = this.personality;
    const now = performance.now();
    switch (signal.type) {
      case 'message': {
        const here = this.here(signal.roomId);
        const reaction = messageReaction(p, { mention: signal.mention, here, own: signal.own, length: signal.length });
        if (this.frozen) {
          if (!signal.own) this.hold(signal.mention ? 3 : 1, signal.mention ? reaction : { expression: 'surprised', emote: 'exclaim', motion: 'perk', hold: 1000 });
          return;
        }
        // A busy conversation gets glances, not a creature bouncing on every line:
        // it only reacts with its body after a quiet spell, and only a mention wakes it.
        const quietFor = now - this.lastMessageAt;
        if (!signal.own) this.lastMessageAt = now;
        if (this.asleep) {
          if (!signal.mention) return;
          this.wake('signal');
        }
        if (!signal.mention && !signal.own && quietFor < (here ? 20_000 : 8000)) {
          this.look(here ? { x: this.x - 320, y: this.y - 240 } : { x: 24, y: window.innerHeight / 2 }, 1200);
          return;
        }
        if (this.runTask(PRIORITY.signal, (task) => this.perform(reaction, task)) && !signal.own) {
          this.look(here ? { x: this.x - 320, y: this.y - 260 } : { x: 24, y: window.innerHeight * 0.4 }, 1600);
        }
        return;
      }
      case 'typing': {
        if (!signal.typing) {
          this.typingSeen.delete(signal.userId);
          return;
        }
        if (this.frozen || this.asleep || !this.here(signal.roomId) || this.typingSeen.has(signal.userId)) return;
        this.typingSeen.add(signal.userId);
        if (this.task) return;
        this.emote('dots');
        this.look({ x: this.perch!.surface.left - 40, y: this.y - 16 }, 1800);
        return;
      }
      case 'gesture': {
        if (signal.userId === this.self) {
          if (this.frozen) return;
          if (this.asleep) this.wake('signal');
          const own: Reaction = signal.gesture === 'celebrate'
            ? { expression: 'happy', emote: 'confetti', motion: 'jump', mouth: 'open', hold: 1300 }
            : signal.gesture === 'nod'
              ? { expression: 'happy', motion: 'nod', mouth: 'smile', hold: 1000 }
              : { expression: 'happy', emote: 'note', motion: 'tilt', mouth: 'smile', hold: 1100 };
          this.runTask(PRIORITY.signal, (task) => this.perform(own, task));
          return;
        }
        if (!this.here(signal.roomId)) return;
        if (this.frozen) {
          this.hold(2, gestureReaction(p, signal.gesture));
          return;
        }
        if (this.asleep) this.wake('signal');
        if (this.visiting || !this.canMove()) {
          this.runTask(PRIORITY.signal, (task) => this.perform(gestureReaction(p, signal.gesture), task));
          return;
        }
        const visit: Visit = { id: signal.id, userId: signal.userId, name: signal.name, character: signal.character, gesture: signal.gesture };
        this.runTask(PRIORITY.signal, (task) => this.visit(visit, task));
        return;
      }
      case 'friend-online': {
        if (this.frozen || this.asleep || now - this.lastFriendAt < 30_000) return;
        this.lastFriendAt = now;
        this.runTask(PRIORITY.signal, (task) => this.perform({ expression: 'happy', emote: 'note', motion: 'perk', mouth: 'smile', hold: 1100 }, task));
        return;
      }
      case 'call': {
        if (this.frozen) return;
        if (this.asleep) this.wake('signal');
        this.scheduleRefresh(260);
        const reaction: Reaction = signal.joined
          ? { expression: 'happy', emote: 'sparkle', motion: 'jump', mouth: 'open', hold: 1200 }
          : { expression: 'sad', motion: 'shrink', hold: 1300 };
        this.runTask(PRIORITY.signal, (task) => this.perform(reaction, task));
        if (!signal.joined) delete this.el.root.dataset.talking;
        return;
      }
      case 'call-peer': {
        if (this.frozen || this.asleep || !signal.joined) return;
        this.runTask(PRIORITY.signal, (task) => this.perform({ expression: 'happy', emote: 'note', motion: 'tilt', mouth: 'smile', hold: 1000 }, task));
        return;
      }
      case 'speaking': {
        if (signal.self) {
          if (signal.active && !this.frozen) {
            if (this.asleep) this.wake('signal');
            this.el.root.dataset.talking = 'true';
          } else delete this.el.root.dataset.talking;
          return;
        }
        if (this.frozen || this.asleep) return;
        if (signal.active) this.look({ x: window.innerWidth / 2, y: window.innerHeight * 0.35 }, 2500);
        return;
      }
      case 'send-failed': {
        if (this.frozen) return;
        this.runTask(PRIORITY.signal, (task) => this.perform({ expression: 'sad', emote: 'sweat', motion: 'shrink', hold: 1600 }, task));
        return;
      }
    }
  };

  // ---------------------------------------------------------------- visits

  /**
   * A friend's creature drops in, does what its owner sent, bumps into yours
   * and leaves. Entirely local: the gesture event already came over the
   * socket, and nothing about the visit is sent anywhere.
   */
  private async visit(visit: Visit, signal: AbortSignal) {
    const surface = this.perch?.surface;
    if (!surface || surface.right - surface.left < this.size * 2.6) {
      await this.perform(gestureReaction(this.personality, visit.gesture), signal);
      return;
    }
    this.visiting = true;
    let guestEyes: Gaze | undefined;
    try {
      const guest = await new Promise<VisitorElements>((resolve, reject) => {
        this.visitorWaiter = resolve;
        const timeout = this.later(1500, () => reject(aborted()));
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(aborted());
        }, { once: true });
        this.hooks.setVisit(visit);
      });
      const guestSize = guest.root.offsetWidth || this.size;
      const room = surface.right - surface.left;
      const side = this.x - surface.left > room / 2 ? -1 : 1;
      const gap = this.size * 1.3;
      const gx = clamp(this.x + side * gap, surface.left, surface.right);
      const at = (x: number, y: number) => this.translate(x, y, guestSize);
      // Final positions are written before each animation, so finishing one never snaps back.
      guest.root.style.transform = at(gx, surface.y);
      guest.root.dataset.ready = 'true';
      const svg = guest.svg();
      if (svg && !this.reduced) guestEyes = gaze(svg, { target: this.el.root });
      this.look(guest.root, 8000);

      await Promise.all([
        this.animate(guest.root, [{ transform: at(gx, -guestSize * 0.3) }, { transform: at(gx, surface.y) }], { duration: 640, easing: 'cubic-bezier(.55,0,1,.45)' }, signal),
        this.animate(guest.body, [{ transform: 'scale(.86,1.18)' }, { transform: 'scale(.9,1.14)' }], { duration: 640 }, signal),
      ]);
      this.setFace('surprised', 'o');
      this.emote('exclaim');
      await this.bodyMotion(BODY_MOTIONS.land, signal, guest.body, undefined);

      const motion = visit.gesture === 'wave' ? 'tilt' : visit.gesture === 'nod' ? 'nod' : 'jump';
      this.emote(visit.gesture === 'celebrate' ? 'confetti' : visit.gesture === 'wave' ? 'note' : 'heart', guest.fx);
      await this.bodyMotion(BODY_MOTIONS[motion], signal, guest.body, undefined);
      await this.perform(gestureReaction(this.personality, visit.gesture), signal);

      // The bump: both lean in, squash at contact, and part with a heart.
      const meet = (this.x + gx) / 2;
      const reach = this.size * 0.4;
      const mine = meet - side * reach;
      const theirs = meet + side * reach;
      const hop = leapFrames(this.size * 0.35);
      guest.root.style.transform = at(theirs, surface.y);
      await Promise.all([
        this.travel([{ transform: this.translate(this.x, this.y) }, { transform: this.translate(mine, this.y) }], { x: mine, y: this.y }, { duration: 420, easing: 'ease-in-out' }, signal),
        this.animate(this.el.hop, hop.hop, { duration: 420 }, signal),
        this.animate(guest.root, [{ transform: at(gx, surface.y) }, { transform: at(theirs, surface.y) }], { duration: 420, easing: 'ease-in-out' }, signal),
      ]);
      this.setFace('love', 'cat', true);
      this.emote('heart');
      await Promise.all([
        this.animate(this.el.body, [{ transform: `scale(.8,1.08) skewX(${side * -8}deg)` }, { transform: 'none' }], { duration: 360, easing: 'ease-out' }, signal),
        this.animate(guest.body, [{ transform: `scale(.8,1.08) skewX(${side * 8}deg)` }, { transform: 'none' }], { duration: 360, easing: 'ease-out' }, signal),
      ]);
      await this.wait(500, signal);

      const exitX = theirs + side * this.size * 3;
      guest.root.style.opacity = '0';
      await Promise.all([
        this.animate(guest.root, [
          { transform: at(theirs, surface.y) },
          { transform: at((theirs + exitX) / 2, surface.y - this.size * 2.2), offset: 0.5 },
          { transform: at(exitX, surface.y - this.size * 0.6), opacity: 0 },
        ], { duration: 700, easing: 'ease-in' }, signal),
        this.animate(guest.body, leapFrames(0).body, { duration: 700 }, signal),
      ]);
      this.setFace('happy', 'smile');
      await this.bodyMotion(BODY_MOTIONS.tilt, signal);
      this.relax();
    } finally {
      guestEyes?.stop();
      this.visiting = false;
      this.visitorWaiter = undefined;
      if (this.started) this.hooks.setVisit(null);
      this.look(null);
    }
  }
}
