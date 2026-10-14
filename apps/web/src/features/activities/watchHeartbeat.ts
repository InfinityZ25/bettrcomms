import { ApiRequestError } from '@/api';

export type WatchHeartbeatResult =
  'present' | 'changed' | 'interrupted' | 'revoked' | 'skipped';

/** Viewing and hosting have different permissions and independent lifetimes. */
export async function keepWatchPresence(
  viewing: () => Promise<unknown>,
  hosting?: () => Promise<unknown>,
): Promise<WatchHeartbeatResult> {
  try {
    if ((await viewing()) === false) return 'skipped';
  } catch (error) {
    return error instanceof ApiRequestError &&
      [401, 403, 404].includes(error.status)
      ? 'revoked'
      : 'interrupted';
  }
  if (!hosting) return 'present';
  try {
    await hosting();
    return 'present';
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.status === 401) return 'revoked';
      if ([403, 404, 409].includes(error.status)) return 'changed';
    }
    return 'interrupted';
  }
}
