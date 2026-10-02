import { afterEach, describe, expect, it, vi } from 'vitest';
import { avatarApiPath, avatarSnapshot, clearAvatarCache, subscribeAvatar } from './avatarCache';
import { apiAuthHeaders, apiCredentials, apiHttpUrl } from '@/desktop/apiTransport';
vi.mock('@/desktop/apiTransport', () => ({
  apiHttpUrl: vi.fn((path: string) => `http://127.0.0.1:9999${path}`),
  apiAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test-host-token' })),
  apiCredentials: vi.fn(() => 'omit'),
}));
const path = '/api/v1/users/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/avatar?version=1';
afterEach(() => { clearAvatarCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });
describe('authenticated avatar cache', () => {
  it('only authorizes exact versioned API image paths', () => {
    expect(avatarApiPath(path.replace('/api/v1', ''))).toBe(path);
    for (const value of ['https://evil.example/avatar', '//evil.example/users/x/avatar', '/api/v1/me', '/users/../me/avatar?version=1', path + '&redirect=https://evil.example', path.replace('?version=1', ''), 'data:image/png;base64,eA==']) expect(avatarApiPath(value)).toBeUndefined();
  });
  it('deduplicates image requests and uses packaged Wails authorization', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('png', { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:avatar');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const stopFirst = subscribeAvatar(path, () => {});
    const stopSecond = subscribeAvatar(path, () => {});
    await vi.waitFor(() => expect(avatarSnapshot(path)).toBe('blob:avatar'));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(`http://127.0.0.1:9999${path}`, expect.objectContaining({ credentials: 'omit', headers: { Authorization: 'Bearer test-host-token' } }));
    expect(apiHttpUrl).toHaveBeenCalledWith(path);
    expect(apiAuthHeaders).toHaveBeenCalled();
    expect(apiCredentials).toHaveBeenCalled();
    stopFirst(); stopSecond();
    clearAvatarCache();
    expect(revoke).toHaveBeenCalledWith('blob:avatar');
  });
  it('aborts an in-flight image when its last viewer disappears', () => {
    let signal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url, options) => { signal = options.signal; return new Promise(() => {}); }));
    const stop = subscribeAvatar(path, () => {});
    expect(signal.aborted).toBe(false);
    stop();
    expect(signal.aborted).toBe(true);
    expect(avatarSnapshot(path)).toBeUndefined();
  });
  it('never allocates a blob URL for oversized or unsupported content', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(256 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } })));
    const changed = vi.fn();
    subscribeAvatar(path, changed);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
    clearAvatarCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })));
    changed.mockClear();
    subscribeAvatar(path, changed);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
  });
});
