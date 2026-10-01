import { useEffect, useRef } from 'react';

type Direction = -1 | 1;
type Entry<T> = { key: string; value: T };

/** In-app history: navigation restores UI, never starts or stops call media. */
export function useMobileSwipeNavigation<T>({
  enabled,
  suspended,
  session,
  backRevision,
  value,
  restore,
  valid,
}: {
  enabled: boolean;
  suspended: boolean;
  session: string | null;
  backRevision: number;
  value: T;
  restore: (value: T) => void;
  valid: (value: T) => boolean;
}) {
  const key = JSON.stringify(value);
  const history = useRef<{
    entries: Entry<T>[];
    index: number;
    pending: string | null;
    session: string | null;
    backRevision: number;
  }>({ entries: [], index: -1, pending: null, session, backRevision });
  const latest = useRef({ suspended, restore, valid });
  latest.current = { suspended, restore, valid };

  useEffect(() => {
    const state = history.current;
    const returning = state.backRevision !== backRevision;
    state.backRevision = backRevision;
    if (state.session !== session || !enabled) {
      state.entries = [];
      state.index = -1;
      state.pending = null;
      state.session = session;
    }
    if (!enabled || suspended) return;
    if (state.pending) {
      // Reconcile the committed UI too: a call may end or a room may refresh
      // during restoration. Don't leave history stuck waiting for stale flags.
      state.entries[state.index] = { key, value };
      state.pending = null;
      return;
    }
    if (state.entries[state.index]?.key === key) return;
    // A Close or Back button returning to the previous surface should leave
    // that surface available to a forward gesture, just like a back swipe.
    if (returning && state.entries[state.index - 1]?.key === key) {
      state.index--;
      return;
    }
    state.entries = state.entries.slice(0, state.index + 1);
    state.entries.push({ key, value });
    if (state.entries.length > 50) state.entries.shift();
    state.index = state.entries.length - 1;
  }, [enabled, suspended, session, key, backRevision]);

  useEffect(() => {
    if (!enabled) return;
    let gesture: {
      x: number;
      y: number;
      time: number;
      direction: Direction;
      committed: boolean;
    } | null = null;
    const nextIndex = (direction: Direction) => {
      const state = history.current;
      for (
        let index = state.index + direction;
        index >= 0 && index < state.entries.length;
        index += direction
      )
        if (latest.current.valid(state.entries[index].value)) return index;
      return -1;
    };
    const start = (event: TouchEvent) => {
      gesture = null;
      if (
        event.touches.length !== 1 ||
        latest.current.suspended ||
        (window.visualViewport && window.visualViewport.scale !== 1) ||
        document.fullscreenElement
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      // Form edits, playback, camera/screen pan and sliders own their gestures.
      if (
        !target ||
        target.closest(
          'input,textarea,select,[contenteditable="true"],[role="slider"],[data-slot="slider"],video,canvas,.video-viewport,.camera-tile,[role="menu"],[role="listbox"]',
        )
      )
        return;
      const dialog = target.closest('[role="dialog"]');
      if (dialog && !dialog.matches('.settings-dialog,.friends-dialog')) return;
      if (!dialog && document.querySelector('[role="dialog"]')) return;
      if (!target.closest('[data-app-shell],.settings-dialog,.friends-dialog'))
        return;
      const touch = event.touches[0];
      const width = window.visualViewport?.width ?? window.innerWidth;
      const direction: Direction | null =
        touch.clientX <= 28 ? -1 : touch.clientX >= width - 28 ? 1 : null;
      if (!direction || nextIndex(direction) < 0) return;
      gesture = {
        x: touch.clientX,
        y: touch.clientY,
        time: event.timeStamp,
        direction,
        committed: false,
      };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1) {
        gesture = null;
        return;
      }
      const touch = event.touches[0];
      const x = (touch.clientX - gesture.x) * -gesture.direction;
      const y = Math.abs(touch.clientY - gesture.y);
      if (!gesture.committed && ((y > 12 && y >= x) || x < -12)) {
        gesture = null;
        return;
      }
      if (x > 16 && x > y * 1.5) gesture.committed = true;
      if (gesture.committed && event.cancelable) event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const current = gesture;
      gesture = null;
      if (
        !current ||
        !current.committed ||
        event.changedTouches.length !== 1 ||
        event.timeStamp - current.time > 1200
      )
        return;
      const touch = event.changedTouches[0];
      const x = (touch.clientX - current.x) * -current.direction;
      if (x < 72 || x < Math.abs(touch.clientY - current.y) * 1.5) return;
      const index = nextIndex(current.direction);
      if (index < 0) return;
      const state = history.current;
      state.index = index;
      state.pending = state.entries[index].key;
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      latest.current.restore(state.entries[index].value);
    };
    const cancel = () => {
      gesture = null;
    };
    document.addEventListener('touchstart', start, {
      capture: true,
      passive: true,
    });
    document.addEventListener('touchmove', move, {
      capture: true,
      passive: false,
    });
    document.addEventListener('touchend', end, true);
    document.addEventListener('touchcancel', cancel, true);
    return () => {
      document.removeEventListener('touchstart', start, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', end, true);
      document.removeEventListener('touchcancel', cancel, true);
    };
  }, [enabled]);
}
