import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Message } from '@/api';
import { conversationSnapshot, loadConversation, loadPins, markRead, receiveMessage, startMessagingSession } from './messageStore';
import { clearDraft, readDraft, saveDraft } from './drafts';
import { clearTyping, receiveTyping, subscribeTyping, typingSnapshot } from './typingStore';

vi.mock('@/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api')>()), api: vi.fn() }));
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.mocked(api).mockReset(); vi.unstubAllGlobals(); clearTyping(); });
const message = (id: string, root?: string, version = 1): Message => ({ id, room_id: 'room', body: id, sequence: 3, version, created_at: '2026-10-01T00:00:00Z', author: { id: 'peer', name: 'Peer', email: 'peer@example.test' }, thread_root_id: root });

describe('independent thread scopes', () => {
  it('keeps realtime replies out of the room timeline and another thread', async () => {
    vi.mocked(api).mockResolvedValueOnce({ rooms: [] }); stop = startMessagingSession('user');
    vi.mocked(api).mockResolvedValueOnce({ messages: [message('main')], read_sequence: 0 }).mockResolvedValueOnce({ members: [] });
    await loadConversation('room');
    vi.mocked(api).mockResolvedValueOnce({ messages: [], root: message('root'), read_sequence: 0 }).mockResolvedValueOnce({ members: [] });
    await loadConversation('room', false, 'root');
    receiveMessage('user', message('reply', 'root'));
    receiveMessage('user', message('other reply', 'other'));
    expect(conversationSnapshot('room').messages.map((item) => item.id)).toEqual(['main']);
    expect(conversationSnapshot('room', 'root').messages.map((item) => item.id)).toEqual(['reply']);
    receiveMessage('user', { ...message('root', undefined, 2), thread_reply_count: 1 });
    expect(conversationSnapshot('room', 'root').root?.thread_reply_count).toBe(1);
  });

  it('reads a thread through its own endpoint, preserving the main cursor', async () => {
    vi.mocked(api).mockResolvedValueOnce({ rooms: [{ room_id: 'room', read_sequence: 2, unread: 1, mentions: 0 }] }); stop = startMessagingSession('user');
    vi.mocked(api).mockResolvedValueOnce({ messages: [message('reply', 'root')], read_sequence: 0 }).mockResolvedValueOnce({ members: [] });
    await loadConversation('room', false, 'root');
    vi.mocked(api).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ rooms: [] });
    await markRead('room', message('reply', 'root'), 'root');
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/rooms/room/threads/root/read')).toBe(true);
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/rooms/room/read')).toBe(false);
    expect(conversationSnapshot('room', 'root').unreadBoundary).toBe(3);
  });

  it('isolates persistent drafts and ephemeral typing per thread', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    saveDraft('user', 'room', { body: 'Main draft', attachments: [] });
    saveDraft('user', 'room', { body: 'Thread draft', attachments: [] }, 'root');
    clearDraft('user', 'room', 'root');
    expect(readDraft('user', 'room').body).toBe('Main draft');
    expect(readDraft('user', 'room', 'root').body).toBe('');
    const listener = vi.fn(); const unsubscribe = subscribeTyping('room', listener, 'root');
    receiveTyping('room', 'peer', true, 'root');
    expect(listener).toHaveBeenCalledOnce(); expect(typingSnapshot('room')).toEqual([]); expect(typingSnapshot('room', 'root')).toEqual(['peer']);
    unsubscribe();
  });

  it('does not resurrect a pin removed while its HTTP list was in flight', async () => {
    vi.mocked(api).mockResolvedValueOnce({ rooms: [] }); stop = startMessagingSession('user');
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = loadPins('room');
    receiveMessage('user', { ...message('pin', undefined, 2), pinned_at: undefined });
    resolve({ messages: [{ ...message('pin'), pinned_at: '2026-10-01T00:00:00Z' }] });
    await pending;
    expect(conversationSnapshot('room').pins).toEqual([]);
  });
});
