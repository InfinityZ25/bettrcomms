import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

type User = { id: string; name: string; email: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;
const json = async <T>(response: APIResponse) => {
  if (!response.ok()) throw new Error(`${response.status()} ${await response.text()}`);
  return response.json() as Promise<T>;
};
async function login(context: BrowserContext, name: string, email: string) {
  const value = await json<User | { user: User }>(await context.request.post('/api/v1/auth/dev', {
    headers: { Origin: origin }, data: { name, email },
  }));
  return 'user' in value ? value.user : value;
}
async function room(a: BrowserContext, b: BrowserContext) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const one = await login(a, 'Relay One', `relay-one-${suffix}@example.test`);
  const two = await login(b, 'Relay Two', `relay-two-${suffix}@example.test`);
  const request = await json<{ request: { id: string } }>(await a.request.post('/api/v1/friends/requests', {
    headers: { Origin: origin }, data: { user_id: two.id },
  }));
  await json(await b.request.post(`/api/v1/friends/requests/${request.request.id}/accept`, { headers: { Origin: origin }, data: {} }));
  const created = await json<{ room: { id: string } }>(await a.request.post('/api/v1/rooms', {
    headers: { Origin: origin }, data: { name: `Relay ${suffix}` },
  }));
  await json(await a.request.post(`/api/v1/rooms/${created.room.id}/members`, {
    headers: { Origin: origin }, data: { user_id: two.id },
  }));
  return { one, two, id: created.room.id };
}

async function setup(page: Page, local: string, remote: string, roomId: string) {
  await page.goto('/');
  await page.evaluate(async ({ local, remote, roomId }) => {
    const { MediaEngine, RoomWebSocketSignaling } = await import('/src/media/index.ts');
    const signaling = new RoomWebSocketSignaling(local, `/api/v1/rooms/${roomId}/ws`);
    const realSend = signaling.send.bind(signaling);
    let direct = false;
    signaling.send = signal => {
      if ('transport' in signal && signal.transport === 'voice-relay') return realSend(signal);
      if (direct) return realSend(signal);
    };
    const engine = new MediaEngine({
      signaling,
      voiceRelay: { url: `/api/v1/rooms/${roomId}/voice-relay`, mode: 'automatic' },
    });
    signaling.addEventListener('signal', event => void engine.handleSignal(event.detail));
    signaling.addEventListener('peers', event => event.detail.peerIds.forEach(id => engine.addPeer(id)));
    signaling.addEventListener('peer-joined', event => engine.addPeer(event.detail.peerId));
    signaling.addEventListener('peer-left', event => engine.removePeer(event.detail.peerId));
    const context = new AudioContext({ sampleRate: 48_000 });
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    oscillator.frequency.value = 440; gain.gain.value = 0.14;
    oscillator.connect(gain).connect(destination); oscillator.start();
    await context.resume();
    const microphone = destination.stream.getAudioTracks()[0];
    await engine.setLocalTrack('microphone', microphone);
    await signaling.connect();
    engine.addPeer(remote);
    Object.assign(window as any, {
      relayTest: {
        engine, signaling, microphone,
        enableDirect() { direct = true; },
        async recoverDirect() {
          const peer = (engine as any).peers.get(remote);
          if (peer?.pc.signalingState === 'have-local-offer')
            await peer.pc.setLocalDescription({ type: 'rollback' });
          peer?.pc.restartIce();
          await (engine as any).negotiate(remote, peer);
        },
        interruptRelay() { (engine as any).voiceRelay?.socket?.close(); },
        mute(value: boolean) { microphone.enabled = !value; },
        state: async () => ({
          remotes: engine.getRemoteTracks(remote).filter(track => track.source === 'microphone').length,
          relay: (engine as any).relayTracks.has(remote),
          socketGeneration: (engine as any).voiceRelay?.socketGeneration,
          socketState: (engine as any).voiceRelay?.socket?.readyState,
          connected: (engine as any).peers.get(remote)?.pc.connectionState,
          signaling: (engine as any).peers.get(remote)?.pc.signalingState,
          polite: (engine as any).peers.get(remote)?.polite,
          localDescription: (engine as any).peers.get(remote)?.pc.localDescription?.type,
          remoteDescription: (engine as any).peers.get(remote)?.pc.remoteDescription?.type,
        }),
        cleanup: async () => {
          engine.dispose(); signaling.close(); oscillator.stop(); microphone.stop(); await context.close();
        },
      },
    });
  }, { local, remote, roomId });
}

async function rms(page: Page) {
  return page.evaluate(async () => {
    const track = (window as any).relayTest.engine.getRemoteTracks()
      .find((item: any) => item.source === 'microphone')?.track;
    if (!track) return 0;
    const context = new AudioContext({ sampleRate: 48_000 });
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    await context.resume();
    const samples = new Float32Array(analyser.fftSize);
    let value = 0;
    for (let i = 0; i < 20; i += 1) {
      analyser.getFloatTimeDomainData(samples);
      value = Math.max(value, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await context.close();
    return value;
  });
}

test('real room relays encrypted processed voice, mutes, then returns to direct WebRTC', async ({ browser }) => {
  const a = await browser.newContext({ baseURL });
  const b = await browser.newContext({ baseURL });
  try {
    const users = await room(a, b);
    const pa = await a.newPage(); const pb = await b.newPage();
    await Promise.all([
      setup(pa, users.one.id, users.two.id, users.id),
      setup(pb, users.two.id, users.one.id, users.id),
    ]);
    await expect.poll(() => pb.evaluate(() => (window as any).relayTest.state()), { timeout: 15_000 })
      .toMatchObject({ remotes: 1, relay: true });
    expect(await rms(pb)).toBeGreaterThan(0.01);
    expect(await pb.evaluate(() => {
      const test = (window as any).relayTest;
      return test.engine.getRemoteTracks().find((item: any) => item.source === 'microphone').track !== test.microphone;
    })).toBe(true);
    await pa.evaluate(() => (window as any).relayTest.mute(true));
    await expect.poll(() => rms(pb), { timeout: 3_000 }).toBeLessThan(0.005);
    const generation = await pb.evaluate(() => (window as any).relayTest.state().then((state: any) => state.socketGeneration));
    await pb.evaluate(() => (window as any).relayTest.interruptRelay());
    await expect.poll(() => pb.evaluate(() => (window as any).relayTest.state()), { timeout: 8_000 })
      .toMatchObject({ remotes: 1, relay: true, socketState: 1, socketGeneration: generation + 1 });
    await Promise.all([
      pa.evaluate(() => { (window as any).relayTest.mute(false); (window as any).relayTest.enableDirect(); }),
      pb.evaluate(() => (window as any).relayTest.enableDirect()),
    ]);
    await Promise.all([
      pa.evaluate(() => (window as any).relayTest.recoverDirect()),
      pb.evaluate(() => (window as any).relayTest.recoverDirect()),
    ]);
    await expect.poll(() => pa.evaluate(() => (window as any).relayTest.state()), { timeout: 10_000 })
      .toMatchObject({ connected: 'connected' });
    await expect.poll(() => pb.evaluate(() => (window as any).relayTest.state()), { timeout: 10_000 })
      .toMatchObject({ connected: 'connected' });
    await expect.poll(() => pb.evaluate(() => (window as any).relayTest.state()), { timeout: 8_000 })
      .toMatchObject({ remotes: 1, relay: false });
  } finally {
    for (const context of [a, b]) for (const page of context.pages())
      await page.evaluate(() => (window as any).relayTest?.cleanup()).catch(() => undefined);
    await Promise.all([a.close(), b.close()]);
  }
});

test('direct-only mode never constructs a voice relay WebSocket', async ({ page }) => {
  await page.goto('/');
  const sockets = await page.evaluate(async () => {
    const Original = window.WebSocket;
    let count = 0;
    window.WebSocket = class extends Original { constructor(url: string | URL, protocols?: string | string[]) { count += 1; super(url, protocols); } };
    try {
      const { MediaEngine } = await import('/src/media/index.ts');
      const engine = new MediaEngine({
        signaling: { localPeerId: 'one', send: async () => undefined },
        ice: { mode: 'direct-only' },
        voiceRelay: { url: '/api/v1/rooms/nope/voice-relay', mode: 'relay' },
      });
      engine.addPeer('two');
      await new Promise(resolve => setTimeout(resolve, 50));
      engine.dispose();
      return count;
    } finally { window.WebSocket = Original; }
  });
  expect(sockets).toBe(0);
});
