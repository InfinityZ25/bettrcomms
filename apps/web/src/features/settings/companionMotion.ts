export type CompanionGestureKind = 'wave' | 'nod' | 'celebrate';
export type CompanionMotionPreference = 'expressive' | 'quiet';
type MotionSnapshot = { preference: CompanionMotionPreference; enabled: boolean };
const STORAGE_KEY = 'bc-companion-motion';
const listeners = new Set<() => void>();
const active = new Set<Animation>();
const arrivals = new Set<string>();
const gestures = new Set<string>();
let media: MediaQueryList | undefined;
let state: MotionSnapshot = { preference: readPreference(), enabled: true };
let detach: (() => void) | undefined;
let subscriptionGeneration = 0;

function readPreference(): CompanionMotionPreference {
  try { return localStorage.getItem(STORAGE_KEY) === 'quiet' ? 'quiet' : 'expressive'; }
  catch { return 'expressive'; }
}

function refresh() {
  const enabled = state.preference === 'expressive' && !media?.matches && (typeof document === 'undefined' || !document.hidden);
  if (typeof document !== 'undefined') document.documentElement.dataset.companionMotion = enabled ? 'expressive' : 'quiet';
  if (!enabled) for (const animation of active) animation.cancel();
  if (enabled === state.enabled) return;
  state = { ...state, enabled };
  for (const listener of listeners) listener();
}

function attach() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const storage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    state = { ...state, preference: readPreference() };
    refresh();
    for (const listener of listeners) listener();
  };
  media.addEventListener('change', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('storage', storage);
  refresh();
  return () => {
    media?.removeEventListener('change', refresh);
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('storage', storage);
    media = undefined;
    for (const animation of active) animation.cancel();
    active.clear();
  };
}

export const companionMotionSnapshot = () => state;
export function subscribeCompanionMotion(listener: () => void) {
  subscriptionGeneration += 1;
  listeners.add(listener);
  if (!detach) detach = attach();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      const generation = ++subscriptionGeneration;
      void Promise.resolve().then(() => {
        if (listeners.size || generation !== subscriptionGeneration) return;
        detach?.();
        detach = undefined;
      });
    }
  };
}

export function setCompanionMotion(preference: CompanionMotionPreference) {
  if (preference === state.preference) return;
  state = { ...state, preference };
  try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* The current view still applies it. */ }
  refresh();
  for (const listener of listeners) listener();
}

function claim(tokens: Set<string>, id?: string) {
  if (!id || tokens.has(id)) return false;
  tokens.add(id);
  if (tokens.size > 2048) tokens.delete(tokens.values().next().value!);
  return true;
}

const motions: Record<'arrival' | CompanionGestureKind, { frames: Keyframe[]; duration: number }> = {
  arrival: { duration: 620, frames: [
    { transform: 'translate(-18%, 12%) scale(.96,.9)', opacity: 0 },
    { transform: 'translate(-7%, -16%) scale(.96,1.04)', opacity: 1, offset: .4 },
    { transform: 'translate(0,2%) scale(1.06,.95)', offset: .75 },
    { transform: 'translate(0,0) scale(1)', opacity: 1 },
  ] },
  wave: { duration: 700, frames: [
    { transform: 'rotate(0)' }, { transform: 'rotate(-12deg)', offset: .22 },
    { transform: 'rotate(10deg)', offset: .48 }, { transform: 'rotate(-6deg)', offset: .72 },
    { transform: 'rotate(0)' },
  ] },
  nod: { duration: 480, frames: [
    { transform: 'translateY(0) scale(1)' }, { transform: 'translateY(5%) scale(1.04,.94)', offset: .45 },
    { transform: 'translateY(0) scale(1)' },
  ] },
  celebrate: { duration: 740, frames: [
    { transform: 'translateY(0) rotate(0)' }, { transform: 'translateY(-14%) rotate(-7deg)', offset: .3 },
    { transform: 'translateY(-8%) rotate(7deg)', offset: .6 }, { transform: 'translateY(0) rotate(0)' },
  ] },
};

/** Only true events animate. Consuming a hidden event also prevents replay on navigation. */
type MotionRequest = { arrivalId?: string; arrivalAt?: number; gesture?: { id: string; kind: CompanionGestureKind } };
type ScheduledMotion = { key: string; owners: number; cleanup?: () => void; disposed: boolean };
const scheduled = new WeakMap<HTMLElement, ScheduledMotion>();

/** StrictMode may replay refs after microtasks; the same DOM node retains its event. */
export function scheduleCompanionMotion(node: HTMLElement, request: MotionRequest) {
  const key = JSON.stringify([request.arrivalId, request.arrivalAt, request.gesture?.id, request.gesture?.kind]);
  let record = scheduled.get(node);
  if (!record || record.key !== key) {
    if (record) { record.disposed = true; record.cleanup?.(); }
    record = { key, owners: 0, disposed: false };
    scheduled.set(node, record);
    const next = record;
    void Promise.resolve().then(() => {
      if (!next.disposed && next.owners) next.cleanup = animateCompanion(node, request);
    });
  }
  record.owners += 1;
  const owned = record;
  return () => {
    owned.owners -= 1;
    void Promise.resolve().then(() => {
      if (owned.owners || owned.disposed) return;
      owned.disposed = true;
      owned.cleanup?.();
      if (scheduled.get(node) === owned) scheduled.delete(node);
    });
  };
}

export function animateCompanion(node: HTMLElement, request: MotionRequest) {
  const arrived = claim(arrivals, request.arrivalId);
  const gestured = request.gesture && claim(gestures, request.gesture.id);
  const kind = gestured ? request.gesture!.kind : arrived ? 'arrival' : undefined;
  if (kind === 'arrival' && request.arrivalAt !== undefined && Date.now() - request.arrivalAt > 1500) return;
  if (!kind || !state.enabled || state.preference === 'quiet' || document.hidden || active.size >= 2 || typeof node.animate !== 'function') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const bounds = node.getBoundingClientRect();
  if (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.right <= 0 || bounds.top >= window.innerHeight || bounds.left >= window.innerWidth) return;
  const motion = motions[kind];
  const animation = node.animate(motion.frames, { duration: motion.duration, easing: 'cubic-bezier(.22,.61,.36,1)' });
  active.add(animation);
  const done = () => { active.delete(animation); };
  void animation.finished.then(done, done);
  return () => { animation.cancel(); done(); };
}

export function clearCompanionMotion() {
  for (const animation of active) animation.cancel();
  active.clear();
  arrivals.clear();
  gestures.clear();
}
