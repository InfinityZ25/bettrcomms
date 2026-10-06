import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { createActivityFeed } from './activityFeed';
vi.mock('@/api', () => ({ api: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const item = (id: string) => ({ id, kind: 'mention', created_at: '2026-10-06', read: false });

describe('activity feed lifecycle', () => {
  it('can restart after a StrictMode cleanup without accepting old responses', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ items: [item('current')] });
    const feed = createActivityFeed();
    const old = feed.load();
    feed.close(); feed.start();
    await feed.load();
    finish({ items: [item('old')] }); await old;
    expect(feed.snapshot()).toMatchObject({ items: [item('current')], loading: false });
    feed.close();
  });
  it('ignores a delayed response after changing filters', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce({ items: [item('reply')] });
    const feed = createActivityFeed();
    const old = feed.load();
    feed.choose('replies');
    await Promise.resolve(); await Promise.resolve();
    finish({ items: [item('stale')] }); await old;
    expect(feed.snapshot()).toMatchObject({ filter: 'replies', items: [item('reply')], loading: false });
    feed.close();
  });
  it('deduplicates overlapping pages without fetching an unbounded history', async () => {
    vi.mocked(api).mockResolvedValueOnce({ items: [item('one')], next_cursor: 'cursor' })
      .mockResolvedValueOnce({ items: [item('one'), item('two')] });
    const feed = createActivityFeed();
    await feed.load(); await feed.load(true);
    expect(feed.snapshot().items.map((entry) => entry.id)).toEqual(['one', 'two']);
    expect(api).toHaveBeenLastCalledWith('/me/activity?kind=all&limit=30&before=cursor', undefined, undefined, expect.any(AbortSignal));
    feed.close();
  });
  it('aborts and releases the feed when its view closes', async () => {
    let signal!: AbortSignal;
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementation((_path, _body, _method, request) => { signal = request!; return new Promise((resolve) => { finish = resolve; }); });
    const feed = createActivityFeed();
    const loading = feed.load();
    feed.close(); finish({ items: [item('late')] }); await loading;
    expect(signal.aborted).toBe(true);
    expect(feed.snapshot().items).toEqual([]);
    await feed.load(); expect(api).toHaveBeenCalledTimes(1);
  });
  it('keeps an existing page visible when loading more fails', async () => {
    vi.mocked(api).mockResolvedValueOnce({ items: [item('one')], next_cursor: 'cursor' }).mockRejectedValueOnce(new Error('Offline'));
    const feed = createActivityFeed();
    await feed.load(); await feed.load(true);
    expect(feed.snapshot()).toMatchObject({ items: [item('one')], cursor: 'cursor', error: 'Offline', loading: false });
    feed.close();
  });
});
