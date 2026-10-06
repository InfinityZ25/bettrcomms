import { api, type FriendRequest, type Message } from '@/api';

export type ActivityFilter = 'all' | 'mentions' | 'replies' | 'requests';
export type ActivityItem = {
  id: string;
  kind: 'mention' | 'reply' | 'friend_request' | 'dm_request';
  created_at: string;
  read: boolean;
  room_id?: string;
  message?: Message;
  friend_request?: FriendRequest;
  dm_request?: { id: string; sender_id: string; sender_name: string; receiver_id: string; body: string };
};
type FeedState = { filter: ActivityFilter; items: ActivityItem[]; cursor?: string; loading: boolean; error: string };
type FeedPage = { items: ActivityItem[]; next_cursor?: string };
const MAX_ITEMS = 300;

/** One bounded feed per open view. Closing it cancels HTTP and releases history. */
export function createActivityFeed() {
  let state: FeedState = { filter: 'all', items: [], loading: false, error: '' };
  let stopped = false;
  let revision = 0;
  let request: AbortController | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<FeedState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const load = async (append = false) => {
    if (stopped || (append && (state.loading || !state.cursor || state.items.length >= MAX_ITEMS))) return;
    request?.abort();
    const current = new AbortController();
    request = current;
    const operation = ++revision;
    const query = new URLSearchParams({ kind: state.filter, limit: '30' });
    if (append && state.cursor) query.set('before', state.cursor);
    update({ loading: true, error: '' });
    try {
      const page = await api<FeedPage>(`/me/activity?${query}`, undefined, undefined, current.signal);
      if (stopped || current.signal.aborted || operation !== revision) return;
      const entries = [...(append ? state.items : []), ...(page.items ?? [])];
      const items = [...new Map(entries.map((item) => [item.id, item])).values()].slice(0, MAX_ITEMS);
      update({ items, cursor: items.length < MAX_ITEMS ? page.next_cursor : undefined });
    } catch (error) {
      if (!stopped && !current.signal.aborted && operation === revision)
        update({ error: error instanceof Error ? error.message : 'Could not load your activity.' });
    } finally {
      if (!stopped && !current.signal.aborted && operation === revision) update({ loading: false });
      if (request === current) request = undefined;
    }
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load,
    start: () => { stopped = false; },
    choose: (filter: ActivityFilter) => {
      if (filter === state.filter) return;
      update({ filter, items: [], cursor: undefined });
      void load();
    },
    close: () => { stopped = true; revision++; request?.abort(); request = undefined; update({ items: [], cursor: undefined, loading: false }); },
  };
}
