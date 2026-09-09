import { useCallback, useEffect, useRef, useState } from 'react';

export type Screen = 'call' | 'settings' | 'recordings' | 'share';

const screens = {
  '#/settings': 'settings',
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
