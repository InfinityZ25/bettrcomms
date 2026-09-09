/**
 * Preferences live in localStorage, which throws in private windows and when a
 * browser blocks site data. Every read falls back to the default and every write
 * degrades to session-only rather than taking the screen down with it.
 */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Session-only when storage is unavailable. */
  }
}

/** Reads a stored value constrained to a known set, falling back when it is not one of them. */
export function readStoredOption<const T extends string>(
  key: string,
  options: readonly T[],
  fallback: T,
): T {
  const value = readStored(key);
  return options.includes(value as T) ? (value as T) : fallback;
}

/** Reads a stored boolean written as an arbitrary marker string (`'true'`, `'on'`, …). */
export function readStoredFlag(key: string, whenTrue: string, fallback: boolean): boolean {
  const value = readStored(key);
  return value === null ? fallback : value === whenTrue;
}

/** Reads a stored number, falling back when it is missing or not finite. */
export function readStoredNumber(key: string, fallback: number): number {
  const value = Number(readStored(key));
  return Number.isFinite(value) ? value : fallback;
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Session-only when storage is unavailable. */
  }
}
