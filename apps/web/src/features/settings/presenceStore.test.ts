import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { changeOwnPresence, contactStatus, ownPresenceSnapshot, receiveOwnPresence, startPresenceSession } from './presenceStore';
import { setAccountDoNotDisturb } from '@/features/chat/notificationSettings';
vi.mock('@/api', () => ({ api: vi.fn() }));
vi.mock('@/features/chat/notificationSettings', () => ({ setAccountDoNotDisturb: vi.fn() }));
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.clearAllMocks(); });
describe('account presence', () => {
  it('keeps disconnected and invisible contacts offline', () => {
    expect(contactStatus('dnd', false)).toBe('offline');
    expect(contactStatus('invisible', false)).toBe('offline');
    expect(contactStatus('invisible', true)).toBe('offline');
    expect(contactStatus('idle', true)).toBe('idle');
    expect(contactStatus('dnd', true)).toBe('dnd');
  });
  it('applies a remote status update without writing device preferences', () => {
    stop = startPresenceSession('user');
    receiveOwnPresence('user', 'dnd');
    expect(ownPresenceSnapshot()).toMatchObject({ userId: 'user', status: 'dnd' });
    expect(setAccountDoNotDisturb).toHaveBeenLastCalledWith('user', true);
  });
  it('keeps a newer cross-device event when an older save response arrives', async () => {
    let finish!: (value: { status: string }) => void;
    vi.mocked(api).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    stop = startPresenceSession('user');
    const pending = changeOwnPresence('user', 'dnd');
    receiveOwnPresence('user', 'invisible');
    finish({ status: 'dnd' });
    await pending;
    expect(ownPresenceSnapshot()).toMatchObject({ status: 'invisible', busy: false });
  });
  it('ignores delayed writes and old cleanup after switching accounts', async () => {
    let finish!: (value: { status: string }) => void;
    vi.mocked(api).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const oldStop = startPresenceSession('alice');
    const pending = changeOwnPresence('alice', 'dnd');
    stop = startPresenceSession('bob', 'idle');
    oldStop();
    finish({ status: 'dnd' });
    await pending;
    expect(ownPresenceSnapshot()).toMatchObject({ userId: 'bob', status: 'idle', busy: false });
  });
  it('leaves the current status intact and shows a failed save', async () => {
    stop = startPresenceSession('user', 'idle');
    vi.mocked(api).mockRejectedValue(new Error('Offline'));
    await changeOwnPresence('user', 'online');
    expect(ownPresenceSnapshot()).toMatchObject({ status: 'idle', busy: false, error: 'Offline' });
  });
});
