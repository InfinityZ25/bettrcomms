import { afterEach, expect, it, vi } from 'vitest';
import { readConnectionMode } from './connectionMode';
vi.mock('../lib/storage', () => ({ readStored: (key: string) => globalThis.localStorage.getItem(key) }));
afterEach(() => vi.unstubAllGlobals());
it.each([
  ['automatic', 'true', 'automatic'], ['direct-only', 'false', 'direct-only'],
  ['relay-only', 'true', 'relay-only'], [null, 'true', 'direct-only'],
  [null, null, 'automatic'], ['invalid', 'false', 'automatic'],
])('reads %s with legacy %s as %s', (mode, legacy, expected) => {
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'bc-connection-mode' ? mode : legacy });
  expect(readConnectionMode()).toBe(expected);
});
