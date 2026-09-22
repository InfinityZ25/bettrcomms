import { readStored } from '../lib/storage';

export type ConnectionMode = 'automatic' | 'direct-only' | 'relay-only';

/** Retain the old explicit direct-only preference until a new mode is saved. */
export function readConnectionMode(): ConnectionMode {
  const mode = readStored('bc-connection-mode');
  if (mode === 'automatic' || mode === 'direct-only' || mode === 'relay-only') return mode;
  return readStored('bc-direct') === 'true' ? 'direct-only' : 'automatic';
}
