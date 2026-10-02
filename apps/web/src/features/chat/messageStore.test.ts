import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Message } from '@/api';
import {
  conversationSnapshot,
  jumpToMessage,
  loadConversation,
  markRead,
  mergeMessages,
  receiveMessage,
  reconcileMessaging,
  startMessagingSession,
  subscribeConversation,
  refreshCachedProfiles,
} from './messageStore';
import { clearProfiles, receiveProfile } from '@/features/settings/profileStore';

vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  api: vi.fn(),
}));
let stop: (() => void) | undefined;
afterEach(() => {
  clearProfiles();
  stop?.();
  stop = undefined;
  vi.mocked(api).mockReset();
});

const message = (id: string, sequence: number, version = 1): Message => ({
  id,
  sequence,
  version,
  room_id: 'room',
  body: id,
  created_at: '2026-09-01T00:00:00Z',
  author: { id: 'user', name: 'Person', email: 'person@example.test' },
});
describe('message reconciliation', () => {
  it('keeps a new author profile when an older HTTP history finishes after its event', async () => {
    vi.mocked(api).mockResolvedValueOnce({ rooms: [] });
    stop = startMessagingSession('user');
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ members: [{ user: { id: 'user', name: 'Old', email: '', profile_version: 1 } }] });
    const loading = loadConversation('room');
    receiveProfile({ id: 'user', name: 'Current', email: '', profile_version: 2 });
    refreshCachedProfiles();
    finish({ messages: [{ ...message('old', 1), author: { id: 'user', name: 'Old', email: '', profile_version: 1 } }] });
    await loading;
    expect(conversationSnapshot('room').messages[0].author.name).toBe('Current');
    expect(conversationSnapshot('room').members[0].name).toBe('Current');
  });
  it('moves the unread divider after a successful read', async () => {
    vi.mocked(api).mockResolvedValueOnce({ rooms: [] });
    stop = startMessagingSession('user');
    vi.mocked(api)
      .mockResolvedValueOnce({ messages: [message('one', 1)], read_sequence: 0 })
      .mockResolvedValueOnce({ members: [] });
    await loadConversation('room');
    vi.mocked(api).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ rooms: [] });
    await markRead('room', message('one', 1));
    expect(conversationSnapshot('room').unreadBoundary).toBe(1);
  });
  it('discards inactive history after reconnect before reopening a fresh page', async () => {
    vi.mocked(api).mockResolvedValueOnce({ rooms: [] });
    stop = startMessagingSession('user');
    vi.mocked(api)
      .mockResolvedValueOnce({
        messages: [message('old', 1)],
        before_id: 'old-cursor',
      })
      .mockResolvedValueOnce({ members: [] });
    await loadConversation('room');
    expect(conversationSnapshot('room').before).toBe('old-cursor');
    vi.mocked(api).mockResolvedValueOnce({ rooms: [] });
    reconcileMessaging('user');
    expect(conversationSnapshot('room').messages).toEqual([]);
    vi.mocked(api)
      .mockResolvedValueOnce({
        messages: [message('new', 101)],
        before_id: 'new-cursor',
      })
      .mockResolvedValueOnce({ members: [] });
    await loadConversation('room');
    expect(conversationSnapshot('room').before).toBe('new-cursor');
    expect(
      conversationSnapshot('room').messages.map((item) => item.id),
    ).toEqual(['new']);
  });
  it('recovers every missed message for an open conversation without losing older pages', async () => {
    vi.mocked(api).mockResolvedValueOnce({ rooms: [] });
    stop = startMessagingSession('user');
    const unsubscribe = subscribeConversation('room', () => {});
    vi.mocked(api)
      .mockResolvedValueOnce({ messages: [message('old', 1)], before_id: 'older', read_sequence: 0 })
      .mockResolvedValueOnce({ members: [] });
    await loadConversation('room');
    vi.mocked(api)
      .mockResolvedValueOnce({ rooms: [] })
      .mockResolvedValueOnce({ messages: [{ ...message('old', 1, 2), body: 'edited' }, message('two', 2), message('three', 3)], before_id: 'three' })
      .mockResolvedValueOnce({ messages: [message('four', 4)] });
    reconcileMessaging('user');
    await vi.waitFor(() => {
      expect(conversationSnapshot('room').messages.map((item) => item.id)).toEqual(['old', 'two', 'three', 'four']);
      expect(conversationSnapshot('room').messages[0].body).toBe('edited');
    });
    expect(conversationSnapshot('room').before).toBe('older');
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/rooms/room/messages?after_sequence=0&limit=100')).toBe(true);
    unsubscribe();
  });
  it('keeps a distant search hit out of pagination and updates its deletion live', async () => {
    vi.mocked(api).mockResolvedValueOnce({ rooms: [] });
    stop = startMessagingSession('user');
    vi.mocked(api)
      .mockResolvedValueOnce({
        messages: [message('recent', 101)],
        before_id: 'recent',
      })
      .mockResolvedValueOnce({ members: [] });
    await loadConversation('room');
    vi.mocked(api).mockResolvedValueOnce({ message: message('old', 1) });
    await jumpToMessage('room', 'old');
    expect(
      conversationSnapshot('room').messages.map((item) => item.id),
    ).toEqual(['recent']);
    receiveMessage('user', {
      ...message('old', 1, 2),
      body: '',
      deleted_at: '2026-09-02T00:00:00Z',
    });
    expect(conversationSnapshot('room').anchor?.body).toBe('');
    expect(conversationSnapshot('room').before).toBe('recent');
    expect(conversationSnapshot('room').messages.at(-1)?.id).toBe('recent');
  });
  it('updates a distant reply quote when its unloaded parent changes', async () => {
    vi.mocked(api).mockResolvedValueOnce({ rooms: [] });
    stop = startMessagingSession('user');
    vi.mocked(api)
      .mockResolvedValueOnce({ messages: [message('recent', 101)] })
      .mockResolvedValueOnce({ members: [] });
    await loadConversation('room');
    vi.mocked(api).mockResolvedValueOnce({
      message: {
        ...message('reply', 2),
        reply: { id: 'parent', name: 'Person', body: 'old quote', deleted: false },
      },
    });
    await jumpToMessage('room', 'reply');

    receiveMessage('user', { ...message('parent', 1, 2), body: 'new quote' });
    expect(conversationSnapshot('room').anchor?.reply?.body).toBe('new quote');
    receiveMessage('user', {
      ...message('parent', 1, 3),
      body: '',
      deleted_at: '2026-09-02T00:00:00Z',
    });
    expect(conversationSnapshot('room').anchor?.reply).toMatchObject({
      body: '',
      deleted: true,
    });
    expect(conversationSnapshot('room').messages.map((item) => item.id)).toEqual([
      'recent',
    ]);
  });
  it('does not restore an old version when a fetch overlaps a live edit or deletion', () => {
    const deleted = {
      ...message('one', 1, 3),
      body: '',
      deleted_at: '2026-09-02T00:00:00Z',
    };
    expect(
      mergeMessages([deleted], [message('one', 1, 1), message('two', 2)]).map(
        (m) => [m.id, m.body],
      ),
    ).toEqual([
      ['one', ''],
      ['two', 'two'],
    ]);
  });
  it('orders equal-timestamp pages by sequence and deduplicates socket deliveries', () => {
    expect(
      mergeMessages(
        [message('three', 3), message('two', 2)],
        [message('one', 1), message('two', 2)],
      ).map((m) => m.id),
    ).toEqual(['one', 'two', 'three']);
  });
  it('removes quoted content immediately when a loaded reply parent is deleted', () => {
    const reply = {
      ...message('reply', 2),
      reply: {
        id: 'parent',
        name: 'Person',
        body: 'private text',
        deleted: false,
      },
    };
    const parent = {
      ...message('parent', 1, 2),
      body: '',
      deleted_at: '2026-09-02T00:00:00Z',
    };
    expect(mergeMessages([reply], [parent])[1].reply).toEqual({
      id: 'parent',
      name: 'Person',
      body: '',
      deleted: true,
    });
  });
  it('does not restore a deleted reply preview from an overlapping old page with the same message version', () => {
    const current = {
      ...message('reply', 2),
      reply: { id: 'parent', name: 'Person', body: '', deleted: true },
    };
    const stale = {
      ...current,
      reply: { ...current.reply, body: 'deleted content', deleted: false },
    };
    expect(mergeMessages([current], [stale])[0].reply?.deleted).toBe(true);
    expect(mergeMessages([current], [stale])[0].reply?.body).toBe('');
  });
});
