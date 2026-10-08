import { api, type ChannelActivitySnapshot } from './activityApi';
import { ApiRequestError } from '@/api';
import { subscribeActivityEvents } from './activityEvents';
import {
  callPresenceSnapshot,
  subscribeCallPresence,
} from '@/features/call/useCallPresence';

export function createChannelActivityStore(roomId: string) {
  let state = {
    data: {
      polls: [],
      events: [],
      assets: [],
      watch: null,
    } as ChannelActivitySnapshot,
    loading: true,
    error: '',
    receivedAt: performance.now(),
  };
  const listeners = new Set<() => void>();
  let active = false;
  let generation = 0;
  let loading = false;
  let reloadAfter = false;
  let controller: AbortController | undefined;
  function update(patch: Partial<typeof state>) {
    if (!active) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  async function load() {
    if (!active || !controller) return;
    if (loading) {
      reloadAfter = true;
      return;
    }
    loading = true;
    const current = controller;
    const requestGeneration = generation;
    try {
      const data = await api<ChannelActivitySnapshot>(
        `/rooms/${roomId}/activities`,
        undefined,
        undefined,
        current.signal,
      );
      if (requestGeneration === generation && !current.signal.aborted)
        update({
          data,
          error: '',
          loading: false,
          receivedAt: performance.now(),
        });
    } catch (error) {
      if (requestGeneration === generation && !current.signal.aborted)
        update({
          ...(error instanceof ApiRequestError &&
          [401, 403, 404].includes(error.status)
            ? { data: { polls: [], events: [], assets: [], watch: null } }
            : {}),
          error:
            error instanceof Error
              ? error.message
              : 'Could not load channel activities.',
          loading: false,
        });
    } finally {
      if (requestGeneration === generation) {
        loading = false;
        if (reloadAfter) {
          reloadAfter = false;
          void load();
        }
      }
    }
  }
  function start() {
    active = true;
    generation += 1;
    const mountGeneration = generation;
    controller = new AbortController();
    const current = controller;
    loading = false;
    reloadAfter = false;
    const off = subscribeActivityEvents((event) => {
      if (event.room_id === roomId && event.type === 'channel.activity')
        void load();
    });
    let previous = callPresenceSnapshot();
    const presenceOff = subscribeCallPresence(() => {
      const next = callPresenceSnapshot();
      if (
        next.syncRevision !== previous.syncRevision ||
        next.roomsRevision !== previous.roomsRevision
      )
        void load();
      previous = next;
    });
    // HTTP reconciliation also catches expired polls, lost events, and host leases.
    const timer = setInterval(() => {
      void load();
    }, 10000);
    void load();
    return () => {
      clearInterval(timer);
      off();
      presenceOff();
      current.abort();
      if (generation === mountGeneration) {
        active = false;
        generation += 1;
        loading = false;
        reloadAfter = false;
      }
    };
  }
  return {
    load,
    start,
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
