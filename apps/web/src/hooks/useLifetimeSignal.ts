import { useRef } from 'react';
import { useMountEffect } from './useMountEffect';

/** Dialog requests belong to the mounted account/entity, including mutations. */
export function useLifetimeSignal() {
  const controller = useRef<AbortController | null>(null);
  useMountEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => current.abort();
  });
  return () => {
    if (!controller.current) throw new Error('Request scope unavailable');
    return controller.current.signal;
  };
}
