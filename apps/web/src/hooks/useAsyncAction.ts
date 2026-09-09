import { useCallback, useState } from 'react';
import { errorMessage } from '@/lib/errors';

/**
 * Runs one user-triggered async action at a time, clearing the previous error
 * on entry and reporting a failure instead of letting it reach the console.
 */
export function useAsyncAction(onError: (message: string) => void) {
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (task: () => Promise<void>) => {
      onError('');
      setBusy(true);
      try {
        await task();
      } catch (error) {
        onError(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [onError],
  );

  return { busy, run };
}
