import { useCallback, useEffect, useState } from 'react';
import { readStored, readStoredFlag, writeStored } from '@/lib/storage';

/** An earlier build stored a 'focus' camera placement that no longer exists. */
const readLayout = () => {
  const stored = readStored('bc-layout');
  return !stored || stored === 'focus' ? 'top' : stored;
};

/**
 * The call preferences the shell owns: they are read by the call screen and
 * edited from the settings screen, and they stay on this device.
 */
export function useCallPreferences() {
  const [layout, setLayout] = useState(readLayout);
  const [noise, setNoiseState] = useState(() => readStoredFlag('bc-noise', 'on', true));
  const [balanced, setBalanced] = useState(() => readStoredFlag('bc-balance', 'true', false));

  useEffect(() => {
    writeStored('bc-layout', layout);
    writeStored('bc-noise', noise ? 'on' : 'off');
    writeStored('bc-balance', String(balanced));
  }, [layout, noise, balanced]);

  /** Live capture picks the change up from the event, not from a re-render. */
  const setNoise = useCallback((value: boolean) => {
    writeStored('bc-noise', value ? 'on' : 'off');
    setNoiseState(value);
    window.dispatchEvent(new Event('bc-noise'));
  }, []);

  return { layout, setLayout, noise, setNoise, balanced, setBalanced };
}
