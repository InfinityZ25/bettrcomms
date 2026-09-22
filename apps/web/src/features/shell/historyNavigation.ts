/**
 * Whether the window's back and forward buttons have anywhere to go.
 *
 * The browser will not say. `history.length` counts entries that may belong to
 * other pages, and there is no "can I go back" to ask, so a shell that renders
 * those buttons either enables them always — offering a control that does
 * nothing — or keeps count itself. This keeps count.
 *
 * Each entry this application pushes carries its own position in
 * `history.state`. Back is possible while the current position is past the
 * first, forward while it is short of the furthest one reached. Entries from
 * before the application loaded are deliberately out of scope: these buttons
 * move around BetterComms, not off it.
 */

const POSITION = 'bettercommsPosition';

type Snapshot = { canGoBack: boolean; canGoForward: boolean };

let furthest = 0;
let snapshot: Snapshot = { canGoBack: false, canGoForward: false };
const listeners = new Set<() => void>();
let started = false;

/** The position of the entry showing now, seeding it when it has none. */
function currentPosition(): number {
  const state = history.state as Record<string, unknown> | null;
  const stored = state?.[POSITION];
  if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
  history.replaceState({ ...(state ?? {}), [POSITION]: 0 }, '');
  return 0;
}

function publish() {
  const position = currentPosition();
  if (position > furthest) furthest = position;
  const next = { canGoBack: position > 0, canGoForward: position < furthest };
  if (next.canGoBack === snapshot.canGoBack && next.canGoForward === snapshot.canGoForward) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  furthest = currentPosition();
  // Both fire on a hash navigation, and which one arrives first differs
  // between engines. Publishing is idempotent, so listening to both is simpler
  // than depending on the order.
  window.addEventListener('popstate', publish);
  window.addEventListener('hashchange', publish);
  publish();
}

/**
 * Records that the application just pushed a history entry.
 *
 * Called after the navigation, because the entry has to exist before its
 * position can be written onto it.
 */
export function recordNavigation() {
  start();
  const position = currentPosition() + 1;
  history.replaceState({ ...(history.state ?? {}), [POSITION]: position }, '');
  furthest = position;
  publish();
}

export function subscribeToHistoryNavigation(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHistoryNavigation(): Snapshot {
  return snapshot;
}

/** Clears the tracking. Tests use this; product code does not. */
export function resetHistoryNavigation() {
  furthest = 0;
  snapshot = { canGoBack: false, canGoForward: false };
  listeners.clear();
  started = false;
}
