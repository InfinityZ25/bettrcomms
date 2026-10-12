import { api, type ChannelActivitySnapshot } from './activityApi';
import { ApiRequestError } from '@/api';
import { subscribeActivityEvents } from './activityEvents';
import {
  callPresenceSnapshot,
  subscribeCallPresence,
} from '@/features/call/useCallPresence';

function emptyActivities(): ChannelActivitySnapshot {
  return { polls: [], events: [], assets: [], watch: null };
}

type Reconciliation = {
  generation: number;
  controller: AbortController;
  queued: boolean;
  promise: Promise<void>;
  settle: () => void;
};

export function createChannelActivityStore(roomId: string) {
  let state = {
    data: emptyActivities(),
    loading: true,
    error: '',
    receivedAt: performance.now(),
  };
  const listeners = new Set<() => void>();
  let active = false;
  let generation = 0;
  let reconciliation: Reconciliation | undefined;
  let controller: AbortController | undefined;
  let stopCurrent: (() => void) | undefined;
  function update(patch: Partial<typeof state>) {
    if (!active) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function current(batch: Reconciliation) {
    return (
      active &&
      generation === batch.generation &&
      controller === batch.controller &&
      !batch.controller.signal.aborted
    );
  }
  async function reconcile(batch: Reconciliation) {
    const signal = batch.controller.signal;
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Activities closed', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      do {
        batch.queued = false;
        try {
          const data = await Promise.race([
            api<ChannelActivitySnapshot>(
              `/rooms/${roomId}/activities?watch_sources=file,youtube`,
              undefined,
              undefined,
              signal,
            ),
            cancelled,
          ]);
          // A queued request may follow a mutation that the in-flight read
          // cannot see. Publish only the final response of this batch.
          if (current(batch) && !batch.queued)
            update({
              data,
              error: '',
              loading: false,
              receivedAt: performance.now(),
            });
        } catch (error) {
          if (current(batch)) {
            const accessRemoved =
              error instanceof ApiRequestError &&
              [401, 403, 404].includes(error.status);
            if (accessRemoved || !batch.queued)
              update({
                ...(accessRemoved ? { data: emptyActivities() } : {}),
                error:
                  error instanceof Error
                    ? error.message
                    : 'Could not load channel activities.',
                loading: false,
              });
          }
        }
      } while (current(batch) && batch.queued);
    } finally {
      signal.removeEventListener('abort', abort);
      if (reconciliation === batch) reconciliation = undefined;
      batch.settle();
    }
  }
  function load(): Promise<void> {
    if (!active || !controller || controller.signal.aborted)
      return Promise.resolve();
    if (reconciliation && current(reconciliation)) {
      reconciliation.queued = true;
      return reconciliation.promise;
    }
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const batch: Reconciliation = {
      generation,
      controller,
      queued: false,
      promise,
      settle,
    };
    reconciliation = batch;
    void reconcile(batch);
    return promise;
  }
  function start() {
    stopCurrent?.();
    active = true;
    generation += 1;
    const mountGeneration = generation;
    controller = new AbortController();
    const current = controller;
    update({ data: emptyActivities(), loading: true, error: '' });
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
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      off();
      presenceOff();
      current.abort();
      if (generation === mountGeneration) {
        update({ data: emptyActivities(), loading: false, error: '' });
        active = false;
        generation += 1;
        controller = undefined;
        stopCurrent = undefined;
      }
    };
    stopCurrent = stop;
    return stop;
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
