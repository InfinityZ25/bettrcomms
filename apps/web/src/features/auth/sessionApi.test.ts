import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { setSessionIdentity, subscribeSessionExpiry } from './sessionEvents';

vi.mock('@/desktop/apiTransport', () => ({ apiHttpUrl: (path: string) => path, apiAuthHeaders: () => ({}), apiCredentials: () => 'include' }));
afterEach(() => { vi.unstubAllGlobals(); setSessionIdentity(null); });

describe('API authentication and posting errors', () => {
  it('invalidates a revoked account but preserves a temporary moderation restriction', async () => {
    setSessionIdentity('account');
    const expired = vi.fn(); const stop = subscribeSessionExpiry(expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'slow_mode', message: 'Wait' } }), { status: 429, headers: { 'Retry-After': '12' } })));
    await expect(api('/rooms/test/messages', { body: 'hello' })).rejects.toMatchObject({ status: 429, code: 'slow_mode', retryAfter: 12 });
    expect(expired).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Sign in required' } }), { status: 401 })));
    await expect(api('/me')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledOnce(); stop();
  });
  it('does not let a late response sign out a replacement account', async () => {
    setSessionIdentity('old');
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>((done) => { resolve = done; })));
    const expired = vi.fn(); const stop = subscribeSessionExpiry(expired);
    const pending = api('/me').catch(() => {});
    setSessionIdentity('new');
    resolve(new Response('{}', { status: 401 })); await pending;
    expect(expired).not.toHaveBeenCalled(); stop();
  });
});
