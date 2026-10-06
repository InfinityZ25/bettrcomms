import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { customStatusSnapshot, effectiveCustomStatus, receiveCustomStatus, saveCustomStatus, startCustomStatusSession, validCustomStatus } from './customStatusStore';
import { statusExpiry } from './CustomStatus';

vi.mock('@/api', () => ({ api: vi.fn() }));
let stop: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-06T12:00:00Z')); vi.mocked(api).mockImplementation(() => new Promise(() => {})); });
afterEach(() => { stop?.(); stop = undefined; vi.clearAllMocks(); vi.useRealTimers(); });
describe('custom statuses', () => {
  it('expires statuses with one shared timer and preserves ordering after they disappear', () => {
    stop = startCustomStatusSession('me');
    receiveCustomStatus({ user_id: 'one', version: 4, status: { text: 'Playing', emoji: '🎮', expires_at: new Date(Date.now() + 1000).toISOString() } });
    receiveCustomStatus({ user_id: 'two', version: 2, status: { text: 'Working', emoji: '', expires_at: new Date(Date.now() + 2000).toISOString() } });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(customStatusSnapshot().entries.one).toMatchObject({ version: 4, status: { text: '' } });
    expect(customStatusSnapshot().entries.two.status.text).toBe('Working');
    receiveCustomStatus({ user_id: 'one', version: 3, status: { text: 'Old event', emoji: '' } });
    expect(customStatusSnapshot().entries.one.status.text).toBe('');
    vi.advanceTimersByTime(1000);
    expect(customStatusSnapshot().entries.two.status.text).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps a newer device event over a delayed save response', async () => {
    stop = startCustomStatusSession('me');
    let finish!: (result: unknown) => void;
    vi.mocked(api).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const save = saveCustomStatus({ text: 'My change', emoji: '' });
    receiveCustomStatus({ user_id: 'me', version: 8, status: { text: 'Other device', emoji: '☕' } });
    finish({ version: 7, status: { text: 'My change', emoji: '' } });
    await save;
    expect(api).toHaveBeenLastCalledWith('/me/status', { status: { text: 'My change', emoji: '' } }, 'PUT', expect.any(AbortSignal));
    expect(customStatusSnapshot().entries.me.status.text).toBe('Other device');
  });
  it('bounds the contact cache and clears all statuses and timers on sign out', () => {
    stop = startCustomStatusSession('me');
    receiveCustomStatus({ user_id: 'me', version: 1, status: { text: 'Mine', emoji: '' } });
    for (let index = 0; index < 520; index++) receiveCustomStatus({ user_id: String(index), version: 1, status: { text: 'Status', emoji: '' } });
    expect(Object.keys(customStatusSnapshot().entries)).toHaveLength(512);
    expect(customStatusSnapshot().entries.me.status.text).toBe('Mine');
    stop(); stop = undefined;
    expect(customStatusSnapshot().entries).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores delayed reads and stale cleanup after switching accounts', async () => {
    let finish!: (result: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const oldStop = startCustomStatusSession('alice');
    stop = startCustomStatusSession('bob'); oldStop();
    finish({ status: { text: 'Alice private state', emoji: '' }, version: 3 });
    await Promise.resolve();
    expect(customStatusSnapshot()).toMatchObject({ userId: 'bob', entries: {} });
  });
  it('rejects malformed values and derives expired fallback statuses without showing stale text', () => {
    expect(validCustomStatus({ text: '🙂'.repeat(101), emoji: '' })).toBe(false);
    expect(validCustomStatus({ text: 'OK', emoji: '', expires_at: 'bad' })).toBe(false);
    expect(effectiveCustomStatus({ text: 'Expired', emoji: '☕', expires_at: '2020-01-01T00:00:00Z' }).text).toBe('');
    expect(statusExpiry('30m', null, new Date('2026-10-06T12:00:00Z'))).toBe('2026-10-06T12:30:00.000Z');
    expect(statusExpiry('never')).toBeNull();
    expect(statusExpiry('keep', '2026-10-07T00:00:00Z')).toBe('2026-10-07T00:00:00Z');
  });
});
