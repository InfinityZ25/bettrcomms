import { useCallback, useEffect, useRef, useState } from 'react';
import { recordNavigation } from './historyNavigation';

export type Screen = 'call' | 'recordings' | 'share';

// Settings is deliberately absent. It is a dialog over the current screen
// rather than a place you go, and routing it meant opening it changed the URL
// and closing it walked the history back — a second, invisible navigation for
// what is one button.
const screens = {
  '#/recordings': 'recordings',
  '#/share': 'share',
} as const satisfies Record<string, Screen>;

export const readScreen = (): Screen =>
  screens[location.hash as keyof typeof screens] ?? 'call';

/**
 * The workspace screens are hash routes so the desktop shell and the browser
 * share one history. Leaving the call screen remembers what had focus, and
 * Escape returns there unless a dialog or fullscreen surface owns the key.
 */
export function useScreenRoute() {
  const [screen, setScreen] = useState<Screen>(readScreen);
  const returnFocus = useRef<HTMLElement | null>(null);

  const navigate = useCallback(
    (next: Screen) => {
      if (screen === 'call' && next !== 'call')
        returnFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      location.hash = next === 'call' ? '#/' : '#/' + next;
      history.replaceState({ ...history.state, bettercommsScreen: next }, '');
      // After the push, not before: the entry has to exist before its position
      // can be written onto it.
      recordNavigation();
    },
    [screen],
  );

  useEffect(() => {
    if (screen === 'call') returnFocus.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.fullscreenElement &&
        screen !== 'call' &&
        !document.querySelector('[role="dialog"]')
      )
        navigate('call');
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [screen, navigate]);

  return { screen, setScreen, navigate };
}
