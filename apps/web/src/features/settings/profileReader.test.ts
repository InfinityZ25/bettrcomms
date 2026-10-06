import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from '@/api';
import { createProfileReader, type ProfileResponse } from './profileReader';

vi.mock('@/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api')>()), api: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const profile: ProfileResponse = { user: { id: 'friend', name: 'Friend' }, relationship: 'friend', shared_rooms: [], mutual_friends: [] };
describe('authorized profile reads', () => {
  it('ignores a response captured before a membership or blocking change', async () => {
    let finish!: (value: ProfileResponse) => void;
    vi.mocked(api).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = vi.fn(), error = vi.fn();
    const reader = createProfileReader('friend', result, error);
    const pending = reader.load(); reader.invalidate(); finish(profile); await pending;
    expect(result).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); reader.close();
  });
  it.each([403, 404])('marks an authoritative %i as denied so the card clears previously visible data', async (status) => {
    vi.mocked(api).mockResolvedValueOnce(profile).mockRejectedValueOnce(new ApiRequestError('Profile unavailable', status));
    const result = vi.fn(), error = vi.fn();
    const reader = createProfileReader('friend', result, error);
    await reader.load(); await reader.load();
    expect(result).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledWith('Profile unavailable', true); reader.close();
  });
  it('supports StrictMode cleanup followed by setup without accepting the old request', async () => {
    let finish!: (value: ProfileResponse) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(profile);
    const result = vi.fn();
    const reader = createProfileReader('friend', result, vi.fn());
    const old = reader.load(); reader.close(); reader.start(); await reader.load();
    finish({ ...profile, user: { ...profile.user, name: 'Stale' } }); await old;
    expect(result).toHaveBeenCalledOnce(); expect(result).toHaveBeenCalledWith(profile); reader.close();
  });
  it('keeps recoverable network errors distinct from loss of permission', async () => {
    vi.mocked(api).mockRejectedValue(new Error('Offline'));
    const error = vi.fn(), reader = createProfileReader('friend', vi.fn(), error);
    await reader.load(); expect(error).toHaveBeenCalledWith('Offline', false); reader.close();
  });
  it('releases profile reads when their parent mutation or dialog is cancelled', async () => {
    let signal!: AbortSignal;
    let finish!: (value: ProfileResponse) => void;
    vi.mocked(api).mockImplementation((_path, _body, _method, scope) => { signal = scope!; return new Promise((resolve) => { finish = resolve; }); });
    const result = vi.fn(), parent = new AbortController();
    const reader = createProfileReader('friend', result, vi.fn());
    const pending = reader.load(parent.signal); parent.abort(); expect(signal.aborted).toBe(true);
    finish(profile); await pending; expect(result).not.toHaveBeenCalled(); reader.close();
  });
});
