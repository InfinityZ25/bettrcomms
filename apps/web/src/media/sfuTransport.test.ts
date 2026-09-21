import { afterEach, expect, it, vi } from 'vitest';
import { requestSfuJoin } from './sfuTransport';
const mock = vi.hoisted(() => ({ transport: null as { base: string; token: string } | null }));
vi.mock('../desktop/runtime', () => ({ getDesktopApiTransport: () => mock.transport }));
afterEach(() => { vi.unstubAllGlobals(); mock.transport = null; });
it('requests SFU credentials through the Wails proxy without browser cookies', async () => {
  mock.transport = { base: 'http://127.0.0.1:1234', token: 'fixture' };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'sfu-session', sfu_url: 'wss://sfu.example', ttl_seconds: 30 }) });
  vi.stubGlobal('fetch', fetch);
  expect(await requestSfuJoin('room')).toMatchObject({ token: 'sfu-session' });
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:1234/api/v1/rooms/room/sfu-join', { credentials: 'omit', headers: { Authorization: 'Bearer fixture' } });
});
it('retains same-origin cookie authentication in the browser', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetch);
  await requestSfuJoin('room');
  expect(fetch).toHaveBeenCalledWith('/api/v1/rooms/room/sfu-join', { credentials: 'include', headers: {} });
});
