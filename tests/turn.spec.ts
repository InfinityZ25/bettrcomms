import { expect, test } from '@playwright/test';

test.describe('local TURN relay', () => {
  test.skip(process.env.E2E_TURN !== 'true', 'Set E2E_TURN=true when the local coturn service is running');

  test('forces a two-peer data channel through the configured relay', async ({ context, page }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const login = await context.request.post('/api/v1/auth/dev', {
      headers: { Origin: new URL(process.env.E2E_BASE_URL ?? 'http://localhost:5173').origin },
      data: { name: 'TURN validation', email: `turn-${suffix}@example.test` },
    });
    expect(login.ok(), await login.text()).toBeTruthy();
    await page.goto('/');

    const iceResponse = await page.request.get('/api/v1/ice');
    expect(iceResponse.ok(), await iceResponse.text()).toBeTruthy();
    const { ice_servers: iceServers } = await iceResponse.json() as { ice_servers: RTCIceServer[] };
    expect(iceServers.some((server) => [server.urls].flat().some((url) => String(url).startsWith('turn:')))).toBeTruthy();

    const result = await page.evaluate(async (servers) => {
      const configuration: RTCConfiguration = { iceServers: servers, iceTransportPolicy: 'relay' };
      const left = new RTCPeerConnection(configuration);
      const right = new RTCPeerConnection(configuration);
      const channel = left.createDataChannel('turn-proof');
      let received = '';
      right.ondatachannel = ({ channel: remote }) => { remote.onmessage = ({ data }) => { received = String(data); }; };

      const gatheringComplete = (peer: RTCPeerConnection) => new Promise<void>((resolve) => {
        if (peer.iceGatheringState === 'complete') return resolve();
        const changed = () => {
          if (peer.iceGatheringState !== 'complete') return;
          peer.removeEventListener('icegatheringstatechange', changed);
          resolve();
        };
        peer.addEventListener('icegatheringstatechange', changed);
      });
      const withTimeout = <T>(promise: Promise<T>, label: string) => Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 15_000)),
      ]);

      try {
        await left.setLocalDescription(await left.createOffer());
        await withTimeout(gatheringComplete(left), 'offer ICE gathering');
        await right.setRemoteDescription(left.localDescription!);
        await right.setLocalDescription(await right.createAnswer());
        await withTimeout(gatheringComplete(right), 'answer ICE gathering');
        await left.setRemoteDescription(right.localDescription!);
        await withTimeout(new Promise<void>((resolve) => channel.addEventListener('open', () => resolve(), { once: true })), 'relay data channel');
        channel.send('relayed-ok');
        await withTimeout(new Promise<void>((resolve) => {
          const poll = setInterval(() => { if (received === 'relayed-ok') { clearInterval(poll); resolve(); } }, 20);
        }), 'relay message');

        const selectedTypes = async (peer: RTCPeerConnection) => {
          const stats = await peer.getStats();
          for (const row of stats.values()) {
            if (row.type !== 'candidate-pair' || !row.nominated || row.state !== 'succeeded') continue;
            const local = stats.get(row.localCandidateId);
            const remote = stats.get(row.remoteCandidateId);
            return { local: local?.candidateType, remote: remote?.candidateType };
          }
          return null;
        };
        return { received, left: await selectedTypes(left), right: await selectedTypes(right) };
      } finally {
        left.close();
        right.close();
      }
    }, iceServers);

    expect(result.received).toBe('relayed-ok');
    expect(result.left?.local).toBe('relay');
    expect(result.right?.local).toBe('relay');
  });
});
