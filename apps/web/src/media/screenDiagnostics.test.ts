import { afterEach, describe, expect, it, vi } from 'vitest';
import { h264Parameters, screenReceiverDiagnostics, videoCapabilities } from './screenDiagnostics';

const states = {
  connectionState: 'connected', iceConnectionState: 'connected',
  iceGatheringState: 'complete', signalingState: 'stable',
} as const;

function peer(
  stats: Map<string, Record<string, unknown>>,
  receivers: Array<Record<string, unknown>> = [],
  descriptions?: { local: string; remote: string },
) {
  return {
    ...states,
    getStats: vi.fn(async () => stats),
    getReceivers: vi.fn(() => receivers),
    localDescription: { sdp: descriptions?.local ?? 'a=ice-pwd:SECRET\r\nc=IN IP4 192.0.2.10' },
    remoteDescription: descriptions ? { sdp: descriptions.remote } : null,
  } as unknown as RTCPeerConnection;
}

describe('screen diagnostics allowlist', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('selects only the transport pair and removes addresses, credentials, IDs, and non-finite metrics', async () => {
    const stats = new Map<string, Record<string, unknown>>([
      ['video', { id: 'video', type: 'inbound-rtp', kind: 'video', codecId: 'codec', bytesReceived: 42_000,
        framesDecoded: 75, framesDropped: Number.NaN, jitter: Number.POSITIVE_INFINITY,
        ip: '192.0.2.3', sdp: 'a=ice-pwd:LEAK', token: 'secret', deviceId: 'camera-private-id' }],
      ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264', clockRate: 90_000,
        sdpFmtpLine: 'profile-level-id=42E01F;packetization-mode=1;x-token=SECRET', payloadType: 102 }],
      ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' }],
      ['selected', { id: 'selected', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local',
        remoteCandidateId: 'remote', currentRoundTripTime: 0.023, bytesSent: 9_000, address: '10.0.0.8' }],
      ['arbitrary', { id: 'arbitrary', type: 'candidate-pair', state: 'succeeded', nominated: true,
        localCandidateId: 'poison', remoteCandidateId: 'poison-remote', currentRoundTripTime: 99 }],
      ['local', { id: 'local', type: 'local-candidate', candidateType: 'host', protocol: 'udp', ip: '10.0.0.8', usernameFragment: 'credential' }],
      ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp', address: '203.0.113.7' }],
      ['poison', { id: 'poison', candidateType: 'relay', protocol: 'tcp', ip: '198.51.100.2' }],
      ['poison-remote', { id: 'poison-remote', candidateType: 'relay' }],
    ]);
    const report = await screenReceiverDiagnostics(peer(stats, [{
      track: { kind: 'video', enabled: true, muted: false, readyState: 'live', id: 'private-track-id', label: 'Display 1' },
    }], {
      local: 'm=video 0 UDP/TLS/RTP/SAVPF 102\r\na=fmtp:102 profile-level-id=4d002a;token=LOCAL-SECRET\r\nc=IN IP4 10.1.2.3',
      remote: 'm=video 9 UDP/TLS/RTP/SAVPF 101\r\na=fmtp:101 profile-level-id=42e01f;ice-pwd=REMOTE-SECRET\r\na=candidate:1 1 udp 1 192.0.2.77 5000 typ host',
    }));

    expect(report.video).toEqual({ bytesReceived: 42_000, framesDecoded: 75 });
    expect(report.codec).toEqual({ mimeType: 'video/H264', clockRate: 90_000, profileLevelId: '42E01F', packetizationMode: '1' });
    expect(report.route).toEqual({ state: 'succeeded', localType: 'host', remoteType: 'srflx', protocol: 'udp',
      relayProtocol: undefined, currentRoundTripTime: 0.023, bytesSent: 9_000 });
    expect(report.tracks).toEqual([{ kind: 'video', enabled: true, muted: false, readyState: 'live' }]);
    expect(report.negotiation).toEqual({
      offeredProfiles: ['profile-level-id=42e01f'],
      answeredProfiles: ['profile-level-id=4d002a'],
      videoRejected: true,
    });
    const serialized = JSON.stringify(report);
    for (const secret of ['192.0.2.3', '10.0.0.8', '203.0.113.7', '10.1.2.3', '192.0.2.77', 'SECRET', 'camera-private-id', 'private-track-id', 'Display 1', 'arbitrary'])
      expect(serialized).not.toContain(secret);
  });

  it('parses only allowlisted H264 parameters and tolerates an empty WebView stats report', async () => {
    expect(h264Parameters('foo=secret; PROFILE-LEVEL-ID=64002a; packetization-mode=0; token=private')).toEqual({
      profileLevelId: '64002a', packetizationMode: '0',
    });
    expect(h264Parameters('profile-level-id=../../etc;packetization-mode=7')).toEqual({
      profileLevelId: undefined, packetizationMode: undefined,
    });
    await expect(screenReceiverDiagnostics(peer(new Map()))).resolves.toEqual({
      ...states,
      negotiation: { offeredProfiles: [], answeredProfiles: [], videoRejected: false },
      video: {}, decoder: undefined, powerEfficientDecoder: undefined, codec: undefined, route: undefined, tracks: [],
    });
  });

  it('allowlists receiver video capabilities', () => {
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{
      mimeType: 'video/H264', clockRate: 90_000,
      sdpFmtpLine: 'profile-level-id=4d002a;packetization-mode=1;token=never-export',
      payloadType: 104, privateAddress: '127.0.0.1',
    }] }) });
    expect(videoCapabilities()).toEqual([{
      mimeType: 'video/H264', clockRate: 90_000, profileLevelId: '4d002a', packetizationMode: '1',
    }]);
    expect(JSON.stringify(videoCapabilities())).not.toContain('never-export');
  });
});
