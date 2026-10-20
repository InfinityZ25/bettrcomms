import { lazy, Suspense, useState } from 'react';
import type { User } from '@/api';
import { useMountEffect } from '@/hooks/useMountEffect';
import { usePetSettings } from './petSettings';

const Pet = lazy(() => import('./Pet'));

/**
 * Loads the companion after the app has settled, and only when it is on.
 *
 * Its code lives in its own chunk, fetched once the browser is idle after
 * sign-in, so it never competes with the first paint of your conversations.
 * Switched off, nothing beyond this component and the signal bus is loaded.
 */
export default function PetHost({ user }: { user: User }) {
  const { enabled } = usePetSettings();
  const [ready, setReady] = useState(false);
  useMountEffect(() => {
    const idle = window.requestIdleCallback;
    if (typeof idle === 'function') {
      const handle = idle(() => setReady(true), { timeout: 2500 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = setTimeout(() => setReady(true), 1200);
    return () => clearTimeout(timer);
  });
  if (!enabled || !ready) return null;
  return (
    <Suspense fallback={null}>
      <Pet user={user} />
    </Suspense>
  );
}
