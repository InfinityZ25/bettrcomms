import type { NativeScreenStartOptions } from '@/media/nativeScreen';

/** A participant as the room's realtime presence stream reports them. */
export interface CallPresence {
  user_id: string;
  name?: string;
  muted: boolean;
  deafened: boolean;
  device_count: number;
}

export const EMPTY_CALL_PRESENCE: CallPresence[] = [];

/**
 * Where a finished recording ended up.
 *
 * `failed` means the only copy is the one still held in memory, which is why
 * a notice about it has to stay until somebody deals with it.
 */
export type RecordingSaveState = 'saving' | 'saved' | 'failed';

/** `replace` moves the call to this device; `additional` keeps the other one connected. */
export type JoinMode = 'replace' | 'additional';

/** What the share screen calls back into once the person has chosen a source. */
export interface NativeShareActions {
  onShare(options: NativeScreenStartOptions): Promise<void>;
  onBrowser(): Promise<void>;
  onClose(): void;
}
