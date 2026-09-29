import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

// The iPhone's native glasses sender is replaced by an in-page WebRTC sender
// that implements the same commands. This exercises the real room signaling
// server and both media engines; it does not prove the native encoder.
type User = { id: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function login(context: BrowserContext, name: string, email: string): Promise<User> {
  const value = await json<User | { user: User }>(await context.request.post('/api/v1/auth/dev', {
    headers: { Origin: origin }, data: { name, email },
  }));
  return 'user' in value ? value.user : value;
}

async function sharedRoom(phone: BrowserContext, friend: BrowserContext) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await login(phone, 'Glasses Phone', `glasses-phone-${suffix}@example.test`);
  const other = await login(friend, 'Glasses Friend', `glasses-friend-${suffix}@example.test`);
  const request = await json<{ request: { id: string } }>(await phone.request.post('/api/v1/friends/requests', {
    headers: { Origin: origin }, data: { user_id: other.id },
  }));
  await json(await friend.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, { headers: { Origin: origin }, data: {} }));
  const room = (await json<{ room: { id: string } }>(await phone.request.post('/api/v1/rooms', {
    headers: { Origin: origin }, data: { name: `Glasses ${suffix}` },
  }))).room;
  await json(await phone.request.post(`/api/v1/rooms/${room.id}/members`, {
    headers: { Origin: origin }, data: { user_id: other.id },
  }));
  return room.id;
}

async function fakeNativeSender(page: Page) {
  await page.route('**/src/desktop/iosNativeBindings.ts*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const iosNativeBinding = {};
export async function callIOSNative() {}
export async function callIOSMetaSender(command, args) { return window.__fakeMeta(command, args); }`,
  }));
  await page.route('**/src/media/metaGlassesCamera.ts*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const META_GLASSES_CAMERA_ID = 'meta';
export const hasMetaGlassesCamera = () => false;
export const isMetaGlassesTrack = track => !!track && !!track.__meta;
export async function startMetaGlassesCamera() { throw new Error('unused'); }
export async function reconnectMetaGlassesCamera() {}`,
  }));
}

async function join(page: Page, roomId: string, legacyReceiver = false) {
  await page.goto('/');
  await page.evaluate(async ({ roomId, legacyReceiver }) => {
    const { MediaEngine, RoomWebSocketSignaling } = await import('/src/media/index.ts');
    const id = crypto.randomUUID();
    const signaling = new RoomWebSocketSignaling(id, `/api/v1/rooms/${roomId}/ws?peer_id=${id}`);
    const engine = new MediaEngine({ signaling, ice: { mode: 'direct-preferred', iceServers: [] } });
    signaling.addEventListener('peers', event => event.detail.peerIds.forEach(peer => engine.addPeer(peer)));
    signaling.addEventListener('peer-joined', event => engine.addPeer(event.detail.peerId));
    signaling.addEventListener('signal', (event) => {
      // Clients packaged before the native receiver never answer these.
      if (legacyReceiver && 'transport' in event.detail && event.detail.transport === 'native-camera') return;
      void engine.handleSignal(event.detail).catch(() => undefined);
    });
    Object.assign(window, { __engine: engine });
    await signaling.connect();
  }, { roomId, legacyReceiver });
}

async function startGlasses(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1280;
    const context = canvas.getContext('2d')!;
    setInterval(() => { context.fillStyle = `hsl(${Date.now() % 360},50%,50%)`; context.fillRect(0, 0, 720, 1280); }, 33);
    const source = canvas.captureStream(30).getVideoTracks()[0];
    const connections = new Map<string, RTCPeerConnection>();
    Object.assign(window, {
      __nativeConnections: connections,
      __fakeMeta: async (command: string, args: { peerId: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) => {
        if (command === 'native_screen_start') return { sessionId: crypto.randomUUID(), fps: 30, bitrateMbps: 3 };
        if (command === 'native_screen_peer_offer') {
          const pc = new RTCPeerConnection();
          connections.set(args.peerId, pc);
          pc.addTrack(source);
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise<void>(resolve => {
            if (pc.iceGatheringState === 'complete') resolve();
            pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); };
          });
          return { type: 'offer', sdp: pc.localDescription!.sdp };
        }
        if (command === 'native_screen_peer_answer') await connections.get(args.peerId)?.setRemoteDescription(args.description!);
        if (command === 'native_screen_peer_candidate' && args.candidate) await connections.get(args.peerId)?.addIceCandidate(args.candidate);
        if (command === 'native_screen_peer_connected') return { connected: connections.get(args.peerId)?.connectionState === 'connected' };
        return null;
      },
    });
    const track = canvas.captureStream(30).getVideoTracks()[0] as MediaStreamTrack & { __meta?: boolean };
    track.__meta = true;
    type Engine = { setLocalTrack(source: string, track: MediaStreamTrack): Promise<void> };
    await (window as unknown as { __engine: Engine }).__engine.setLocalTrack('camera', track);
  });
}

type Internals = { peers: Map<string, { senders: Map<string, unknown> }>; nativeCameraRemote: Map<string, unknown>;
  getRemoteTracks(): { source: string }[] };
const phoneSendsCallCamera = (page: Page) => page.evaluate(() =>
  [...(window as unknown as { __engine: Internals }).__engine.peers.values()].map(peer => peer.senders.has('camera')));
const friendCamera = (page: Page) => page.evaluate(() => {
  const engine = (window as unknown as { __engine: Internals }).__engine;
  return { native: engine.nativeCameraRemote.size, cameras: engine.getRemoteTracks().filter(track => track.source === 'camera').length };
});

test('glasses video reaches a client that cannot receive the native stream', async ({ browser }) => {
  const phone = await browser.newContext({ baseURL });
  const friend = await browser.newContext({ baseURL });
  try {
    const roomId = await sharedRoom(phone, friend);
    const phonePage = await phone.newPage();
    await fakeNativeSender(phonePage);
    const friendPage = await friend.newPage();
    await join(phonePage, roomId);
    await join(friendPage, roomId, true);
    await expect.poll(() => phonePage.evaluate(() => (window as unknown as { __engine: Internals }).__engine.peers.size)).toBe(1);
    await startGlasses(phonePage);
    await expect.poll(() => friendCamera(friendPage)).toEqual({ native: 0, cameras: 1 });
    // The probe times out after three seconds; the ordinary camera must stay.
    await phonePage.waitForTimeout(4_000);
    expect(await phoneSendsCallCamera(phonePage)).toEqual([true]);
  } finally {
    await phone.close();
    await friend.close();
  }
});

test('glasses video upgrades to the native stream and falls back when it drops', async ({ browser }) => {
  test.setTimeout(60_000);
  const phone = await browser.newContext({ baseURL });
  const friend = await browser.newContext({ baseURL });
  try {
    const roomId = await sharedRoom(phone, friend);
    const phonePage = await phone.newPage();
    await fakeNativeSender(phonePage);
    const friendPage = await friend.newPage();
    await join(phonePage, roomId);
    await join(friendPage, roomId);
    await expect.poll(() => phonePage.evaluate(() => (window as unknown as { __engine: Internals }).__engine.peers.size)).toBe(1);
    await startGlasses(phonePage);
    await expect.poll(() => phoneSendsCallCamera(phonePage)).toEqual([false]);
    await expect.poll(() => friendCamera(friendPage)).toEqual({ native: 1, cameras: 1 });

    await phonePage.evaluate(() => {
      for (const pc of (window as unknown as { __nativeConnections: Map<string, RTCPeerConnection> }).__nativeConnections.values()) pc.close();
    });
    await expect.poll(() => phoneSendsCallCamera(phonePage), { timeout: 20_000 }).toEqual([true]);
    await expect.poll(() => friendCamera(friendPage)).toEqual({ native: 0, cameras: 1 });
  } finally {
    await phone.close();
    await friend.close();
  }
});
