const DEFAULT_THRESHOLD_DB = -48;

export function normalizeSpeakingThreshold(value: number): number {
  return Number.isFinite(value)
    ? Math.min(-20, Math.max(-65, value))
    : DEFAULT_THRESHOLD_DB;
}

export function readSpeakingThreshold(): number {
  const stored = localStorage.getItem('bc-speaking-threshold');
  return stored === null
    ? DEFAULT_THRESHOLD_DB
    : normalizeSpeakingThreshold(Number(stored));
}

/** Visual activity only: never modifies capture, noise gates, or transmitted audio. */
export function saveSpeakingThreshold(value: number): number {
  const threshold = normalizeSpeakingThreshold(value);
  localStorage.setItem('bc-speaking-threshold', String(threshold));
  window.dispatchEvent(new Event('bc-speaking-threshold'));
  return threshold;
}
