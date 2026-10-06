import { useCallback, useState, useSyncExternalStore } from 'react';
import { readStoredFlag, writeStored } from '@/lib/storage';
import { callPreferencesSnapshot, setCallLayout, setVoiceBalance, subscribeCallPreferences } from './localPreferences';

/**
 * The call preferences the shell owns: they are read by the call screen and
 * edited from settings. Placement and balancing can sync after device opt-in;
 * microphone processing stays local and never restarts from a remote change.
 */
export function useCallPreferences() {
  const { layout, balanced } = useSyncExternalStore(subscribeCallPreferences, callPreferencesSnapshot);
  const [noise, setNoiseState] = useState(() => readStoredFlag('bc-noise', 'on', true));

  /** Live capture picks the change up from the event, not from a re-render. */
  const setNoise = useCallback((value: boolean) => {
    writeStored('bc-noise', value ? 'on' : 'off');
    setNoiseState(value);
    window.dispatchEvent(new Event('bc-noise'));
  }, []);

  return { layout, setLayout: setCallLayout, noise, setNoise, balanced, setBalanced: setVoiceBalance };
}
