import { useCallback, useEffect, useRef, useState } from 'react';
import { getDesktopSignInApi, type DesktopSignInStatus } from '@/desktop';

/**
 * How often the host is asked whether the browser has finished. The host is
 * already polling the API; this only moves its answer into the window.
 */
const POLL_MS = 700;

/**
 * Starting a sign-in, on whichever host is running.
 *
 * In a browser tab and in the Tauri shell the page navigates to the login route
 * and the session comes back in the same cookie jar. The Wails host serves the
 * page from its own origin, so that round trip cannot work there: sign-in runs
 * in the system browser and the host claims the session into its own process.
 * This hook hides that difference from the panels, and exposes the waiting
 * state the desktop needs to show.
 */
export function useWorkOSSignIn(onSignedIn: () => void) {
  const [status, setStatus] = useState<DesktopSignInStatus | null>(null);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;

  const waiting = status?.state === 'waiting';

  useEffect(() => {
    if (!waiting) return;
    const host = getDesktopSignInApi();
    if (!host) return;

    let stopped = false;
    const timer = setInterval(() => {
      void host
        .status()
        .then((next) => {
          if (stopped) return;
          setStatus(next);
          if (next.state === 'complete') signedIn.current();
        })
        .catch(() => {});
    }, POLL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [waiting]);

  const start = useCallback(() => {
    const host = getDesktopSignInApi();
    if (!host) {
      // The page's own origin serves the API here, so navigating is the whole
      // flow: the provider returns to this same document.
      location.assign('/api/v1/auth/login');
      return;
    }
    setStatus({ state: 'waiting', detail: 'Opening your browser…' });
    void host
      .begin()
      .then(setStatus)
      .catch((error: unknown) =>
        setStatus({
          state: 'failed',
          detail:
            error instanceof Error
              ? error.message
              : 'Sign-in could not be started.',
        }),
      );
  }, []);

  const cancel = useCallback(() => {
    setStatus(null);
    void getDesktopSignInApi()?.cancel().catch(() => {});
  }, []);

  return { start, cancel, status };
}
