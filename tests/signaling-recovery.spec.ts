import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

// Two real media engines over the real signaling server. One negotiation
// message is discarded on its way out, as a reconnecting socket or a full
// server queue would, to check the call still connects.
type User = { id: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
// The dev sign-in is rate limited and shared by the whole suite; wait out a
// 429 rather than failing before the test reaches what it checks.
async function login(context: BrowserContext, name: string, email: string): Promise<User> {
  const deadline = Date.now() + 65_000;
  for (;;) {
    const response = await context.request.post('/api/v1/auth/dev', {
      headers: { Origin: origin }, data: { name, email },
    });
    if (response.status() !== 429 || Date.now() >= deadline) {
      const value = await json<User | { user: User }>(response);
      return 'user' in value ? value.user : value;
    }
    await response.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function join(page: Page, roomId: string, lose: 'offer' | 'answer', times = 1) {
  await page.goto('/');
  await page.evaluate(async ({ roomId, lose, times }) => {
    const { MediaEngine, RoomWebSocketSignaling } = await import('/src/media/index.ts');
    const id = crypto.randomUUID();
    const signaling = new RoomWebSocketSignaling(id, `/api/v1/rooms/${roomId}/ws?peer_id=${id}`);
    const send = signaling.send.bind(signaling);
    const state = { lost: 0, errors: [] as string[] };
    signaling.send = async (signal) => {
      // Only the first few: a later repeat must get through.
      if (signal.type === lose && !('transport' in signal && signal.transport) && state.lost < times) { state.lost += 1; return; }
      return send(signal);
    };
    const engine = new MediaEngine({ signaling, ice: { mode: 'direct-preferred', iceServers: [] } });
    engine.addEventListener('error', event => state.errors.push(`${event.detail.operation}: ${String(event.detail.error)}`));
    signaling.addEventListener('peers', event => event.detail.peerIds.forEach(peer => engine.addPeer(peer)));
    signaling.addEventListener('peer-joined', event => engine.addPeer(event.detail.peerId));
    signaling.addEventListener('signal', event => void engine.handleSignal(event.detail).catch(() => undefined));
    Object.assign(window, { __engine: engine, __state: state });
    await engine.captureUserMedia({ camera: false, microphone: true });
    await signaling.connect();
  }, { roomId, lose, times });
}

type Internals = { peers: Map<string, { pc: RTCPeerConnection }> };
const connection = (page: Page) => page.evaluate(() =>
  [...(window as unknown as { __engine: Internals }).__engine.peers.values()][0]?.pc.connectionState ?? 'no peer');

for (const [lose, times] of [['offer', 1], ['answer', 1], ['offer', 7]] as const) {
  test(`a call still connects when the first ${times > 1 ? `${times} ${lose}s are` : `${lose} is`} lost`, async ({ browser }) => {
    // Seven losses outlast the old five-attempt limit.
    test.setTimeout(90_000);
    const first = await browser.newContext({ baseURL, permissions: ['microphone'] });
    const second = await browser.newContext({ baseURL, permissions: ['microphone'] });
    try {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await login(first, 'Recover One', `recover-one-${suffix}@example.test`);
      const other = await login(second, 'Recover Two', `recover-two-${suffix}@example.test`);
      const request = await json<{ request: { id: string } }>(await first.request.post('/api/v1/friends/requests', {
        headers: { Origin: origin }, data: { user_id: other.id },
      }));
      await json(await second.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, { headers: { Origin: origin }, data: {} }));
      const room = (await json<{ room: { id: string } }>(await first.request.post('/api/v1/rooms', {
        headers: { Origin: origin }, data: { name: `Recover ${suffix}` },
      }))).room;
      await json(await first.request.post(`/api/v1/rooms/${room.id}/members`, { headers: { Origin: origin }, data: { user_id: other.id } }));

      const pages = [await first.newPage(), await second.newPage()];
      await join(pages[0], room.id, lose, times);
      await join(pages[1], room.id, lose, times);

      // The loss really happened, on whichever side sent that message.
      await expect.poll(async () => (await Promise.all(pages.map(page =>
        page.evaluate(() => (window as unknown as { __state: { lost: number } }).__state.lost)))).reduce((a, b) => a + b), { timeout: 60_000 }).toBe(times);
      for (const page of pages) await expect.poll(() => connection(page), { timeout: 30_000 }).toBe('connected');
      // Recovering did not raise an error for the user.
      for (const page of pages)
        expect(await page.evaluate(() => (window as unknown as { __state: { errors: string[] } }).__state.errors)).toEqual([]);
    } finally {
      await first.close();
      await second.close();
    }
  });
}
