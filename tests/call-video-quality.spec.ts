import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

// Two real media engines over the real signaling server, with Chromium's fake
// camera. Checks what the browser was actually told to send, not the rules in
// isolation (those are unit-tested in videoQuality.test.ts).
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

async function join(page: Page, roomId: string, camera: boolean) {
  await page.goto('/');
  await page.evaluate(async ({ roomId, camera }) => {
    const { MediaEngine, RoomWebSocketSignaling } = await import('/src/media/index.ts');
    const id = crypto.randomUUID();
    const signaling = new RoomWebSocketSignaling(id, `/api/v1/rooms/${roomId}/ws?peer_id=${id}`);
    // The share ceiling a new user has: 20 Mbps and 60 fps.
    const engine = new MediaEngine({ signaling, quality: { maxVideoBitrate: 20_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 },
      ice: { mode: 'direct-preferred', iceServers: [] } });
    signaling.addEventListener('peers', event => event.detail.peerIds.forEach(peer => engine.addPeer(peer)));
    signaling.addEventListener('peer-joined', event => engine.addPeer(event.detail.peerId));
    signaling.addEventListener('signal', event => void engine.handleSignal(event.detail).catch(() => undefined));
    Object.assign(window, { __engine: engine });
    if (camera) await engine.captureUserMedia({ camera: { width: { ideal: 1280 }, height: { ideal: 720 } }, microphone: false });
    await signaling.connect();
  }, { roomId, camera });
}

type Internals = { peers: Map<string, { pc: RTCPeerConnection; senders: Map<string, RTCRtpSender> }> };

test('a camera is sent at a camera-sized bitrate with one stated codec order', async ({ browser }) => {
  const sender = await browser.newContext({ baseURL, permissions: ['camera'] });
  const viewer = await browser.newContext({ baseURL });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(sender, 'Quality Sender', `quality-sender-${suffix}@example.test`);
    const other = await login(viewer, 'Quality Viewer', `quality-viewer-${suffix}@example.test`);
    const request = await json<{ request: { id: string } }>(await sender.request.post('/api/v1/friends/requests', {
      headers: { Origin: origin }, data: { user_id: other.id },
    }));
    await json(await viewer.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, { headers: { Origin: origin }, data: {} }));
    const room = (await json<{ room: { id: string } }>(await sender.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: `Quality ${suffix}` },
    }))).room;
    await json(await sender.request.post(`/api/v1/rooms/${room.id}/members`, { headers: { Origin: origin }, data: { user_id: other.id } }));

    const sendPage = await sender.newPage();
    const viewPage = await viewer.newPage();
    await join(sendPage, room.id, true);
    await join(viewPage, room.id, false);

    // Negotiated and applied: the camera's ceiling follows its own picture.
    await expect.poll(() => sendPage.evaluate(() => {
      const [peer] = [...(window as unknown as { __engine: Internals }).__engine.peers.values()];
      const camera = peer?.senders.get('camera');
      const settings = camera?.track?.getSettings();
      return { pixels: (settings?.width ?? 0) * (settings?.height ?? 0), encoding: camera?.getParameters().encodings[0] };
    })).toMatchObject({ pixels: 1280 * 720, encoding: { maxBitrate: 2_500_000 } });
    const encoding = await sendPage.evaluate(() => {
      const [peer] = [...(window as unknown as { __engine: Internals }).__engine.peers.values()];
      return peer.senders.get('camera')!.getParameters().encodings[0];
    });
    // The share's 60 fps ceiling is not imposed on the camera.
    expect(encoding.maxFramerate).toBeUndefined();

    // Both descriptions list codecs in the app's order, whoever offered.
    for (const page of [sendPage, viewPage]) {
      await expect.poll(() => page.evaluate(async () => {
        const { preferredVideoCodecs } = await import('/src/media/videoQuality.ts');
        const [peer] = [...(window as unknown as { __engine: Internals }).__engine.peers.values()];
        const sdp = peer?.pc.localDescription?.sdp ?? '';
        if (!sdp.includes('m=video')) return 'not negotiated';
        const video = sdp.slice(sdp.indexOf('m=video'));
        const payload = /^m=video \d+ \S+ (\d+)/m.exec(video)?.[1];
        const first = new RegExp(`^a=rtpmap:${payload} ([^/]+)`, 'm').exec(video)?.[1];
        const expected = preferredVideoCodecs(RTCRtpReceiver.getCapabilities('video')!.codecs)[0].mimeType.split('/')[1];
        return first?.toLowerCase() === expected.toLowerCase() ? 'app order' : `first codec ${first}, expected ${expected}`;
      })).toBe('app order');
    }

    // Switching to a smaller camera mid-call recomputes the ceiling; the
    // replacement keeps its sender and triggers no negotiation.
    await sendPage.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { exact: 640 }, height: { exact: 480 } } });
      type Engine = { setLocalTrack(source: string, track: MediaStreamTrack): Promise<void> };
      await (window as unknown as { __engine: Engine }).__engine.setLocalTrack('camera', stream.getVideoTracks()[0]);
    });
    await expect.poll(() => sendPage.evaluate(() => {
      const [peer] = [...(window as unknown as { __engine: Internals }).__engine.peers.values()];
      const encoding = peer.senders.get('camera')!.getParameters().encodings[0];
      return { maxBitrate: encoding.maxBitrate, maxFramerate: encoding.maxFramerate };
    })).toEqual({ maxBitrate: 1_000_000, maxFramerate: undefined });

    // The viewer actually receives it.
    await expect.poll(() => viewPage.evaluate(async () => {
      const [peer] = [...(window as unknown as { __engine: Internals }).__engine.peers.values()];
      const report = await peer.pc.getStats();
      return [...report.values()].some(row => row.type === 'inbound-rtp' && row.kind === 'video' && row.framesDecoded > 5);
    }), { timeout: 20_000 }).toBe(true);
  } finally {
    await sender.close();
    await viewer.close();
  }
});
