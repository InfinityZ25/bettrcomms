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

/** `replace` moves the call to this device; `additional` keeps the other one connected. */
export type JoinMode = 'replace' | 'additional';

/** What the share screen calls back into once the person has chosen a source. */
export interface NativeShareActions {
  onShare(options: NativeScreenStartOptions): Promise<void>;
  onBrowser(): Promise<void>;
  onClose(): void;
}
