import { api, ApiRequestError, type PublicUser, type Room } from '@/api';
import { errorMessage } from '@/lib/errors';
import type { ContactStatus } from './presenceStore';

export type ProfileResponse = {
  user: PublicUser;
  relationship: 'self' | 'friend' | 'incoming_request' | 'outgoing_request' | 'shared_room';
  shared_rooms: Room[];
  mutual_friends: PublicUser[];
  friend_request_id?: string;
  presence?: ContactStatus;
};

/** A profile must be authorized again after contact or membership changes. */
export function createProfileReader(userId: string, onResult: (profile: ProfileResponse) => void, onError: (message: string, denied: boolean) => void) {
  let stopped = false;
  let revision = 0;
  let request: AbortController | undefined;
  const invalidate = () => { revision += 1; request?.abort(); request = undefined; };
  return {
    start: () => { stopped = false; },
    invalidate,
    close: () => { stopped = true; invalidate(); },
    load: async (parent?: AbortSignal) => {
      if (stopped || parent?.aborted) return;
      invalidate();
      const current = new AbortController(); request = current;
      const operation = revision;
      const abort = () => current.abort();
      parent?.addEventListener('abort', abort, { once: true });
      try {
        const profile = await api<ProfileResponse>(`/users/${encodeURIComponent(userId)}/profile`, undefined, undefined, current.signal);
        if (stopped || current.signal.aborted || operation !== revision) return;
        if (profile.user?.id !== userId || !Array.isArray(profile.shared_rooms) || !Array.isArray(profile.mutual_friends)) throw new Error('This profile could not be loaded.');
        onResult({ ...profile, shared_rooms: profile.shared_rooms.slice(0, 20), mutual_friends: profile.mutual_friends.slice(0, 20) });
      } catch (error) {
        if (!stopped && !current.signal.aborted && operation === revision) onError(errorMessage(error), error instanceof ApiRequestError && (error.status === 403 || error.status === 404));
      } finally {
        parent?.removeEventListener('abort', abort);
        if (request === current) request = undefined;
      }
    },
  };
}
