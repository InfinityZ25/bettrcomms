import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Real API/room signaling and two media engines. Only the native encoder is
// replaced by a WebRTC sender with a canvas and an independently captured tone.
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
async function post(context: BrowserContext, path: string, data: unknown = {}) {
  const response = await context.request.post('/api/v1' + path, {
    headers,
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function join(page: Page, roomId: string) {
  await page.goto('/');
  await page.evaluate(async (roomId) => {
    const { MediaEngine, RoomWebSocketSignaling } =
      await import('/src/media/index.ts');
    const id = crypto.randomUUID();
    const signaling = new RoomWebSocketSignaling(
      id,
      `/api/v1/rooms/${roomId}/ws?peer_id=${id}`,
    );
    const engine = new MediaEngine({ signaling, ice: { iceServers: [] } });
    signaling.addEventListener('peers', (event) =>
      event.detail.peerIds.forEach((peer) => engine.addPeer(peer)),
    );
    signaling.addEventListener('peer-joined', (event) =>
      engine.addPeer(event.detail.peerId),
    );
    signaling.addEventListener(
      'signal',
      (event) => void engine.handleSignal(event.detail),
    );
    Object.assign(window, { __engine: engine });
    await signaling.connect();
  }, roomId);
}
test('native screen app audio reaches the viewer independently and ends with sharing', async ({
  browser,
}) => {
  const sender = await browser.newContext({ baseURL });
  const viewer = await browser.newContext({ baseURL });
  try {
    const suffix = Date.now();
    await post(sender, '/auth/dev', {
      name: 'Broadcast phone',
      email: `broadcast-${suffix}@example.test`,
    });
    const other = await post(viewer, '/auth/dev', {
      name: 'Broadcast viewer',
      email: `viewer-${suffix}@example.test`,
    });
    const request = await post(sender, '/friends/requests', {
      user_id: (other.user ?? other).id,
    });
    await post(viewer, `/friends/requests/${request.request.id}/accept`);
    const { room } = await post(sender, '/rooms', {
      name: `Broadcast ${suffix}`,
    });
    await post(sender, `/rooms/${room.id}/members`, {
      user_id: (other.user ?? other).id,
    });
    const phone = await sender.newPage();
    const desktop = await viewer.newPage();
    await phone.route('**/src/desktop/capture.ts*', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `
    export const invokeNativeCapture=(command,args)=>window.__broadcast(command,args);
    export const onNativeCaptureEnded=async()=>()=>{};
    export const decodeNativeBytes=()=>new ArrayBuffer(0);
  `,
      }),
    );
    await join(phone, room.id);
    await join(desktop, room.id);
    await expect
      .poll(() => phone.evaluate(() => (window as any).__engine.peers.size))
      .toBe(1);
    await phone.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext('2d')!;
      const timer = setInterval(() => {
        context.fillStyle = `hsl(${Date.now() % 360},70%,50%)`;
        context.fillRect(0, 0, 1280, 720);
      }, 33);
      const video = canvas.captureStream(30).getVideoTracks()[0];
      const audioContext = new AudioContext();
      await audioContext.resume();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      gain.gain.value = 0.15;
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      const audio = destination.stream.getAudioTracks()[0];
      const connections = new Map<string, RTCPeerConnection>();
      Object.assign(window, {
        __broadcast: async (command: string, args: any) => {
          if (command === 'native_screen_start')
            return { sessionId: 'broadcast-test', fps: 30, bitrateMbps: 6 };
          if (command === 'native_screen_peer_offer') {
            const pc = new RTCPeerConnection();
            connections.set(args.peerId, pc);
            pc.addTrack(video);
            if (args.appAudio) pc.addTrack(audio);
            const codecs = RTCRtpSender.getCapabilities('video')!.codecs.filter(
              (codec) => codec.mimeType.toLowerCase() === 'video/h264',
            );
            pc.getTransceivers()
              .find((t) => t.sender.track?.kind === 'video')!
              .setCodecPreferences(codecs);
            await pc.setLocalDescription(await pc.createOffer());
            await new Promise<void>((resolve) => {
              if (pc.iceGatheringState === 'complete') resolve();
              pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') resolve();
              };
            });
            return { type: 'offer', sdp: pc.localDescription!.sdp };
          }
          if (command === 'native_screen_peer_answer')
            await connections
              .get(args.peerId)!
              .setRemoteDescription(args.description);
          if (command === 'native_screen_peer_candidate' && args.candidate)
            await connections.get(args.peerId)!.addIceCandidate(args.candidate);
          if (command === 'native_screen_peer_remove') {
            connections.get(args.peerId)?.close();
            connections.delete(args.peerId);
          }
          if (command === 'native_screen_stop') {
            for (const pc of connections.values()) pc.close();
            connections.clear();
            clearInterval(timer);
            video.stop();
            audio.stop();
            oscillator.stop();
            await audioContext.close();
          }
          return null;
        },
      });
      await (window as any).__engine.captureNativeScreen({
        sourceId: 'ios-broadcast',
        encoder: 'libx264',
        width: 1280,
        height: 720,
        fps: 30,
        bitrateMbps: 6,
        cursor: false,
        h264Profile: 'baseline',
        systemAudio: false,
      });
    });
    await expect
      .poll(() =>
        desktop.evaluate(() =>
          (window as any).__engine
            .getRemoteTracks()
            .map((r: any) => `${r.source}:${r.track.kind}`)
            .sort(),
        ),
      )
      .toEqual(['screen:video', 'system:audio']);
    await desktop.evaluate(async () => {
      const track = (window as any).__engine
        .getRemoteTracks()
        .find((r: any) => r.source === 'system');
      const { attachRemoteAudio } = await import('/src/media/remoteAudio.ts');
      Object.assign(window, {
        __stopPlayback: attachRemoteAudio({
          track: track.track,
          peerId: track.peerId,
          balanceVoice: false,
        }),
      });
    });
    const measure = () =>
      desktop.evaluate(async () => {
        const engine = (window as any).__engine;
        const audio = engine
          .getRemoteTracks()
          .find((r: any) => r.source === 'system');
        if (!audio) return 0;
        const context = new AudioContext();
        await context.resume();
        const analyser = context.createAnalyser();
        context.createMediaStreamSource(audio.stream).connect(analyser);
        const silent = context.createGain();
        silent.gain.value = 0;
        analyser.connect(silent).connect(context.destination);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        const rms = Math.sqrt(
          data.reduce((sum, value) => sum + value * value, 0) / data.length,
        );
        await context.close();
        return rms;
      });
    await expect.poll(measure).toBeGreaterThan(0.02);
    await phone.evaluate(() => (window as any).__engine.stopNativeScreen());
    await desktop.evaluate(() => (window as any).__stopPlayback());
    await expect(desktop.locator('audio[data-call-remote-audio]')).toHaveCount(
      0,
    );
    await expect
      .poll(() =>
        desktop.evaluate(() =>
          (window as any).__engine.getRemoteTracks().map((r: any) => r.source),
        ),
      )
      .toEqual([]);
  } finally {
    await sender.close();
    await viewer.close();
  }
});
