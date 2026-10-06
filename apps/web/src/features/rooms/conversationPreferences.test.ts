import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Room } from '@/api';
import { conversationPreferencesSnapshot, receiveConversationPreference, refreshConversationPreferences, setConversationPreference, sortConversations, startConversationPreferencesSession } from './conversationPreferences';
vi.mock('@/api', () => ({ api: vi.fn() }));
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.clearAllMocks(); });
const room: Room = { id: 'room', name: 'Friends', kind: 'group', owner_id: 'alice', created_at: '2026-10-01' };

describe('private conversation preferences', () => {
  it('prunes revoked memberships on the next authoritative refresh', async () => {
    vi.mocked(api).mockResolvedValueOnce({ preferences: { room: { favorite: true, archived: false, version: 1 } } })
      .mockResolvedValueOnce({ preferences: {} });
    stop = startConversationPreferencesSession('alice');
    await Promise.resolve(); await Promise.resolve();
    expect(conversationPreferencesSnapshot().preferences.room).toBeDefined();
    await refreshConversationPreferences();
    expect(conversationPreferencesSnapshot().preferences).toEqual({});
  });
  it('keeps a newer realtime preference when an earlier HTTP response arrives', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    stop = startConversationPreferencesSession('alice');
    receiveConversationPreference({ room_id: 'room', favorite: true, archived: true, version: 3 });
    finish({ preferences: { room: { favorite: false, archived: false, version: 1 } } });
    await Promise.resolve(); await Promise.resolve();
    expect(conversationPreferencesSnapshot().preferences.room).toMatchObject({ favorite: true, archived: true, version: 3 });
  });
  it('serializes writes for the same room without overwriting omitted fields', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockResolvedValueOnce({ preferences: {} });
    stop = startConversationPreferencesSession('alice');
    await Promise.resolve();
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ room_id: 'room', favorite: true, archived: true, version: 2 });
    const first = setConversationPreference(room, { favorite: true });
    const second = setConversationPreference(room, { archived: true });
    await Promise.resolve(); await Promise.resolve();
    expect(api).toHaveBeenCalledTimes(2);
    finish({ room_id: 'room', favorite: true, archived: false, version: 1 });
    await Promise.all([first, second]);
    expect(api).toHaveBeenLastCalledWith('/rooms/room/preferences', { archived: true }, 'PUT', expect.any(AbortSignal));
    expect(conversationPreferencesSnapshot().preferences.room).toMatchObject({ favorite: true, archived: true });
    expect(conversationPreferencesSnapshot().busy.room).toBeUndefined();
  });
  it('isolates responses and cleanup from a previous account', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ preferences: {} });
    const oldStop = startConversationPreferencesSession('alice');
    stop = startConversationPreferencesSession('bob');
    oldStop();
    finish({ preferences: { room: { favorite: true, archived: true, version: 3 } } });
    await Promise.resolve(); await Promise.resolve();
    expect(conversationPreferencesSnapshot()).toMatchObject({ userId: 'bob', preferences: {}, ready: true });
  });
  it('keeps a failed write out of the visible preferences and offers a fetch retry', async () => {
    vi.mocked(api).mockRejectedValue(new Error('Offline'));
    stop = startConversationPreferencesSession('alice');
    await Promise.resolve(); await Promise.resolve();
    expect(conversationPreferencesSnapshot()).toMatchObject({ error: 'Offline', ready: false });
    await expect(setConversationPreference(room, { favorite: true })).rejects.toThrow('Offline');
    expect(conversationPreferencesSnapshot().preferences).toEqual({});
    vi.mocked(api).mockResolvedValue({ preferences: {} });
    await refreshConversationPreferences();
    expect(conversationPreferencesSnapshot()).toMatchObject({ ready: true, error: '' });
  });
  it('sorts favorites first with stable activity order and prohibits channel archiving', async () => {
    expect(sortConversations([{ ...room, id: 'new', created_at: '2026-10-05' }, room], { room: { favorite: true, archived: false, version: 1 } }).map((item) => item.id)).toEqual(['room', 'new']);
    vi.mocked(api).mockResolvedValue({ preferences: {} });
    stop = startConversationPreferencesSession('alice');
    await expect(setConversationPreference({ ...room, kind: 'channel' }, { archived: true })).rejects.toThrow('Only private');
  });
});
