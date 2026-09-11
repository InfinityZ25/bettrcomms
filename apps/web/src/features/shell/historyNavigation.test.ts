import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getHistoryNavigation,
  recordNavigation,
  resetHistoryNavigation,
  subscribeToHistoryNavigation,
} from './historyNavigation';

/**
 * A window and a history the tests drive directly.
 *
 * These tests run in node, so both are stubbed rather than driven through a
 * DOM. What is under test is the bookkeeping — which entry we are on and how
 * far we have been — not the browser's event timing.
 */
function fakeBrowser() {
  const listeners = new Map<string, Set<() => void>>();
  const entries: Array<Record<string, unknown> | null> = [null];
  let position = 0;

  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };

  const win = {
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  };

  const history_ = {
    get state() {
      return entries[position];
    },
    replaceState(state: Record<string, unknown> | null) {
      entries[position] = state;
    },
    /** What setting location.hash does: push, discarding anything ahead. */
    push() {
      entries.splice(position + 1);
      entries.push(null);
      position += 1;
    },
    go(delta: number) {
      position = Math.max(0, Math.min(entries.length - 1, position + delta));
      emit('popstate');
    },
  };

  vi.stubGlobal('window', win);
  vi.stubGlobal('history', history_);
  return history_;
}

let browser: ReturnType<typeof fakeBrowser>;

beforeEach(() => {
  vi.unstubAllGlobals();
  resetHistoryNavigation();
  browser = fakeBrowser();
});

describe('window back and forward', () => {
  it('offers neither before anything has been navigated', () => {
    subscribeToHistoryNavigation(() => {});

    expect(getHistoryNavigation()).toEqual({
      canGoBack: false,
      canGoForward: false,
    });
  });

  it('offers back once the application has gone somewhere', () => {
    subscribeToHistoryNavigation(() => {});

    browser.push();
    recordNavigation();

    expect(getHistoryNavigation()).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  it('offers forward only after going back, and withdraws it at the end', () => {
    subscribeToHistoryNavigation(() => {});
    browser.push();
    recordNavigation();

    browser.go(-1);
    expect(getHistoryNavigation()).toEqual({
      canGoBack: false,
      canGoForward: true,
    });

    browser.go(1);
    expect(getHistoryNavigation()).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  // Going somewhere new discards the entries that were ahead, so forward has to
  // stop being offered — a button that walks into a history that no longer
  // exists is worse than one that is simply disabled.
  it('withdraws forward when a new navigation replaces what was ahead', () => {
    subscribeToHistoryNavigation(() => {});
    browser.push();
    recordNavigation();
    browser.push();
    recordNavigation();
    browser.go(-2);
    expect(getHistoryNavigation().canGoForward).toBe(true);

    browser.push();
    recordNavigation();

    expect(getHistoryNavigation()).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  it('tells subscribers when the answer changes, and not when it does not', () => {
    let notifications = 0;
    subscribeToHistoryNavigation(() => {
      notifications += 1;
    });

    browser.push();
    recordNavigation();
    expect(notifications).toBe(1);

    // The same position again is not news.
    browser.go(0);
    expect(notifications).toBe(1);
  });

  it('stops telling a subscriber that has gone away', () => {
    let notifications = 0;
    const unsubscribe = subscribeToHistoryNavigation(() => {
      notifications += 1;
    });
    unsubscribe();

    browser.push();
    recordNavigation();

    expect(notifications).toBe(0);
  });
});
