import { api, ApiRequestError } from '@/api';
import { subscribePersonalEvents } from './api';

/** One cancellable, paged inbox view; closing it releases all observers. */
export function createPersonalList<T extends { id: string }>(
  path: string,
  field: 'items' | 'reminders',
) {
  let state = { items: [] as T[], cursor: '', loading: true, error: '' };
  let controller: AbortController | undefined;
  let generation = 0;
  let active = false;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  async function load(more = false) {
    if (!active || (more && state.loading)) return;
    controller?.abort();
    const abort = new AbortController();
    controller = abort;
    const request = ++generation;
    update({ loading: true, error: '' });
    try {
      const result = await api<{
        items?: T[];
        reminders?: T[];
        next_cursor?: string;
      }>(
        `${path}${more && state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : ''}`,
        undefined,
        undefined,
        abort.signal,
      );
      if (abort.signal.aborted || request !== generation) return;
      const items = result[field] ?? [];
      update({
        items: more
          ? [
              ...new Map(
                [...state.items, ...items].map((item) => [item.id, item]),
              ).values(),
            ]
          : items,
        cursor: result.next_cursor ?? '',
      });
    } catch (error) {
      if (!abort.signal.aborted && request === generation)
        update({
          ...(error instanceof ApiRequestError &&
          [401, 403, 404].includes(error.status)
            ? { items: [], cursor: '' }
            : {}),
          error:
            error instanceof Error
              ? error.message
              : 'Could not load your inbox.',
        });
    } finally {
      if (request === generation && !abort.signal.aborted)
        update({ loading: false });
    }
  }
  function start() {
    active = true;
    const off = subscribePersonalEvents((type) => {
      if (
        (field === 'items' && type === 'personal.saved.changed') ||
        (field === 'reminders' && type === 'personal.reminders.changed')
      )
        void load();
    });
    const focus = () => {
      void load();
    };
    window.addEventListener('focus', focus);
    void load();
    return () => {
      active = false;
      generation++;
      controller?.abort();
      off();
      window.removeEventListener('focus', focus);
    };
  }
  return {
    start,
    load,
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
