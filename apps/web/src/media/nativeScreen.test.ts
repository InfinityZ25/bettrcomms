import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  native: false,
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock('../desktop/capture', () => ({ invokeNativeCapture: mocks.invoke, onNativeCaptureEnded: mocks.listen }));
vi.mock('../desktop/nativeMedia', () => ({ hasNativeMediaHost: () => mocks.native }));

import { NativeScreenTransport } from './nativeScreen';
import type { MediaSignal, SignalingAdapter } from './types';

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static remoteDescriptionGate?: Promise<void>;
  static stats = new Map<string, Record<string, unknown>>();
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  ontrack: RTCPeerConnection['ontrack'] = null;
  onicecandidate: RTCPeerConnection['onicecandidate'] = null;
  onconnectionstatechange: RTCPeerConnection['onconnectionstatechange'] = null;
  close = vi.fn();
  constructor(public configuration?: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    await FakePeerConnection.remoteDescriptionGate;
    this.remoteDescription = description as RTCSessionDescription;
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: 'browser-answer' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = {
      ...description,
      toJSON: () => ({ type: description.type, sdp: description.sdp }),
    } as RTCSessionDescription;
  }
  getConfiguration() { return this.configuration ?? {}; }
  setConfiguration = vi.fn((configuration: RTCConfiguration) => { this.configuration = configuration; });
  addIceCandidate = vi.fn(async () => undefined);
  getStats = vi.fn(async () => FakePeerConnection.stats as unknown as RTCStatsReport);
}

function setup(directOnly = false, camera = false) {
  const sent: MediaSignal[] = [];
  const signaling: SignalingAdapter = {
    localPeerId: 'self',
    send: vi.fn(async (signal) => {
      sent.push(signal);
    }),
  };
  const preview = vi.fn();
  const remote = vi.fn();
  const removed = vi.fn();
  const ended = vi.fn();
  const fallback = vi.fn(async () => undefined);
  const transport = new NativeScreenTransport(
    signaling,
    [{ urls: 'stun:example.test' }],
    directOnly,
    preview,
    remote,
    removed,
    ended,
    fallback,
    camera ? { invoke: mocks.invoke, listen: mocks.listen, externalPreview: true, closeReceiverOnFallback: true } : undefined,
  );
  return { transport, signaling, sent, preview, remote, removed, ended, fallback };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  FakePeerConnection.instances = [];
  FakePeerConnection.remoteDescriptionGate = undefined;
  FakePeerConnection.stats = new Map();
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  mocks.invoke.mockReset();
  mocks.native = false;
  mocks.listen.mockClear();
  mocks.invoke.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      if (command === 'native_screen_start')
        return { ...args, sessionId: 'capture-1' };
      if (command === 'native_screen_peer_offer')
        return { type: 'offer', sdp: `offer-${args.peerId}` };
      return null;
    },
  );
});

describe('native screen signaling lifecycle', () => {
  it('selects Main only when every current peer explicitly supports it', async () => {
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: () => ({ codecs: [
        { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
        { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=4d001f' },
      ] }),
    });
    const { transport, sent } = setup();
    const starting = transport.start({
      sourceId: 'window:opaque', encoder: 'h264_nvenc', width: 1920,
      height: 1080, fps: 60, bitrateMbps: 20, cursor: true,
      h264Profile: 'auto',
    }, ['peer-a', 'peer-b']);
    await Promise.resolve();
    const query = sent.find((signal) =>
      signal.type === 'signal' && signal.transport === 'native-screen')!;
    for (const peerId of ['peer-a', 'peer-b'])
      await transport.handle({
        type: 'signal', from: peerId, to: 'self', transport: 'native-screen',
        captureId: query.captureId,
        data: { kind: 'native-screen-profile-reply', nonce: query.captureId, profiles: ['baseline', 'main'] },
      } as unknown as MediaSignal);
    await starting;
    expect(mocks.invoke).toHaveBeenCalledWith('native_screen_start',
      expect.objectContaining({ h264Profile: 'main' }));
  });

  it('uses the best local profile without delaying an empty-room start', async () => {
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: () => ({ codecs: [
        { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
        { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=4d001f' },
      ] }),
    });
    const { transport, sent } = setup();
    await transport.start({
      sourceId: 'window:opaque', encoder: 'h264_nvenc', width: 1920,
      height: 1080, fps: 60, bitrateMbps: 20, cursor: true,
      h264Profile: 'auto',
    });
    expect(sent).toEqual([]);
    expect(mocks.invoke).toHaveBeenCalledWith('native_screen_start',
      expect.objectContaining({ h264Profile: 'main' }));
  });

  it('tries the single-encode native path for a desktop viewer before fallback', async () => {
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: () => ({ codecs: [
        { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
      ] }),
    });
    const { transport, sent, fallback } = setup();
    const starting = transport.start({
      sourceId: 'window:opaque', encoder: 'h264_nvenc', width: 1920,
      height: 1080, fps: 60, bitrateMbps: 20, cursor: true,
      h264Profile: 'auto',
    }, ['peer-desktop']);
    await Promise.resolve();
    const query = sent.find(signal => signal.type === 'signal'
      && signal.transport === 'native-screen')!;
    await transport.handle({
      type: 'signal', from: 'peer-desktop', to: 'self', transport: 'native-screen',
      captureId: query.captureId,
      data: {
        kind: 'native-screen-profile-reply', nonce: query.captureId,
        profiles: ['baseline'], runtime: 'desktop',
      },
    });
    await starting;
    expect(transport.compatibilityQuality).toEqual({
      maxVideoBitrate: 20_000_000,
      maxFramerate: 60,
      scaleResolutionDownBy: 1,
    });
    await transport.addPeer('peer-desktop');
    expect(fallback).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('native_screen_peer_offer',
      expect.objectContaining({ peerId: 'peer-desktop' }));
  });

  it('advertises whether the receiver is a desktop WebView', async () => {
    mocks.native = true;
    const { transport, sent } = setup();
    await transport.handle({
      type: 'signal', from: 'peer-a', to: 'self', transport: 'native-screen',
      captureId: 'profile-query',
      data: { kind: 'native-screen-profile-query', nonce: 'profile-query' },
    });
    expect(sent.at(-1)).toMatchObject({
      data: { kind: 'native-screen-profile-reply', runtime: 'desktop' },
    });
  });

  it('rejects more peers than can be validated instead of truncating negotiation', async () => {
    const { transport } = setup();
    await expect(transport.start({
      sourceId: 'window:opaque', encoder: 'h264_nvenc', width: 1920,
      height: 1080, fps: 60, bitrateMbps: 20, cursor: true,
      h264Profile: 'auto',
    }, Array.from({ length: 8 }, (_, index) => `peer-${index}`))).rejects.toThrow(/up to 7/);
    expect(mocks.invoke).not.toHaveBeenCalledWith('native_screen_start', expect.anything());
  });

  it('falls back to baseline when a capability reply is missing', async () => {
    vi.useFakeTimers();
    const { transport } = setup();
    const starting = transport.start({
      sourceId: 'window:opaque', encoder: 'h264_nvenc', width: 1920,
      height: 1080, fps: 60, bitrateMbps: 20, cursor: true,
      h264Profile: 'auto',
    }, ['unknown-peer']);
    await vi.advanceTimersByTimeAsync(1_000);
    await starting;
    expect(mocks.invoke).toHaveBeenCalledWith('native_screen_start',
      expect.objectContaining({ h264Profile: 'baseline' }));
    vi.useRealTimers();
  });

  it('keeps preview local, routes native sender signaling, and sends an explicit stop', async () => {
    const { transport, sent, preview } = setup(true);
    await transport.start({
      sourceId: 'window:opaque',
      encoder: 'h264_amf',
      width: 2560,
      height: 1440,
      fps: 60,
      bitrateMbps: 40,
      cursor: true,
    });

    expect(mocks.invoke).toHaveBeenCalledWith(
      'native_screen_peer_offer',
      expect.objectContaining({
        peerId: '__preview',
        directOnly: true,
        iceServers: [],
      }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      'native_screen_peer_answer',
      expect.objectContaining({
        peerId: '__preview',
        description: expect.objectContaining({ type: 'answer' }),
      }),
    );
    expect(sent).toEqual([]);
    expect(preview).not.toHaveBeenCalled();

    await transport.addPeer('peer-a');
    expect(mocks.invoke).toHaveBeenCalledWith(
      'native_screen_peer_offer',
      expect.objectContaining({ peerId: 'peer-a', directOnly: true }),
    );
    expect(sent.at(-1)).toMatchObject({
      type: 'offer',
      to: 'peer-a',
      transport: 'native-screen',
      captureId: 'capture-1',
    });

    await transport.handle({
      type: 'answer',
      from: 'peer-a',
      to: 'self',
      transport: 'native-screen',
      captureId: 'capture-1',
      description: { type: 'answer', sdp: 'peer-answer' },
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      'native_screen_peer_answer',
      expect.objectContaining({ peerId: 'peer-a' }),
    );

    await transport.stop();
    expect(sent.at(-1)).toMatchObject({
      type: 'signal',
      to: 'peer-a',
      transport: 'native-screen',
      data: { kind: 'native-screen-stop', captureId: 'capture-1' },
    });
    expect(mocks.invoke).toHaveBeenCalledWith('native_screen_stop', {
      sessionId: 'capture-1',
    });
  });

  it('answers an incoming native offer on an isolated receive-only connection and applies candidates', async () => {
    const { transport, sent, remote, removed } = setup();
    await transport.handle({
      type: 'offer',
      from: 'peer-b',
      to: 'self',
      transport: 'native-screen',
      captureId: 'remote-capture',
      description: { type: 'offer', sdp: 'native-offer' },
    });
    const receiver = FakePeerConnection.instances[0];
    expect(receiver.configuration).toEqual({
      iceServers: [{ urls: ['stun:example.test'] }],
    });
    expect(sent.at(-1)).toMatchObject({
      type: 'answer',
      to: 'peer-b',
      captureId: 'remote-capture',
    });

    const track = {
      kind: 'video',
      id: 'screen-track',
      addEventListener: vi.fn(),
    } as unknown as MediaStreamTrack;
    receiver.ontrack?.call(
      receiver as unknown as RTCPeerConnection,
      { track } as RTCTrackEvent,
    );
    expect(remote).toHaveBeenCalledWith('peer-b', track);
    await transport.handle({
      type: 'ice-candidate',
      from: 'peer-b',
      to: 'self',
      transport: 'native-screen',
      captureId: 'remote-capture',
      candidate: { candidate: 'candidate:1' },
    });
    expect(receiver.addIceCandidate).toHaveBeenCalledWith({
      candidate: 'candidate:1',
    });

    await transport.handle({
      type: 'signal',
      from: 'peer-b',
      to: 'self',
      transport: 'native-screen',
      captureId: 'remote-capture',
      data: { kind: 'native-screen-stop', captureId: 'remote-capture' },
    });
    expect(receiver.close).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith('peer-b');
  });

  it('gives a slow handshake a full first-media window after connecting', async () => {
    vi.useFakeTimers();
    const { transport, sent } = setup();
    await transport.handle({
      type: 'offer', from: 'peer-b', to: 'self', transport: 'native-screen',
      captureId: 'remote-capture', description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    const receiver = FakePeerConnection.instances[0];
    receiver.connectionState = 'connecting';
    await vi.advanceTimersByTimeAsync(18_000);
    expect(sent.filter(signal => signal.type === 'signal')).toHaveLength(0);
    receiver.connectionState = 'connected';
    receiver.onconnectionstatechange?.call(receiver as unknown as RTCPeerConnection, new Event('connectionstatechange'));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent.filter(signal => signal.type === 'signal')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.at(-1)).toMatchObject({
      type: 'signal', to: 'peer-b', transport: 'native-screen',
      captureId: 'remote-capture',
      data: { kind: 'native-screen-fallback-request', captureId: 'remote-capture' },
    });
    vi.useRealTimers();
  });

  it('bounds a stuck handshake and cancels deadlines when the receiver stops', async () => {
    vi.useFakeTimers();
    const { transport, sent } = setup();
    const offer = {
      type: 'offer' as const, from: 'peer-b', to: 'self', transport: 'native-screen' as const,
      captureId: 'remote-capture', description: { type: 'offer' as const, sdp: 'v=0\r\n' },
    };
    await transport.handle(offer);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(sent.filter(signal => signal.type === 'signal')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.filter(signal => signal.type === 'signal')).toHaveLength(1);
    await transport.handle({ ...offer, captureId: 'replacement' });
    await transport.handle({
      type: 'signal', from: 'peer-b', to: 'self', transport: 'native-screen',
      captureId: 'replacement', data: { kind: 'native-screen-stop' },
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(sent.filter(signal => signal.type === 'signal')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('keeps a native receiver that has begun receiving RTP', async () => {
    vi.useFakeTimers();
    const { transport, sent } = setup();
    await transport.handle({
      type: 'offer', from: 'peer-b', to: 'self', transport: 'native-screen',
      captureId: 'remote-capture', description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    let frames = 0;
    FakePeerConnection.instances[0].getStats.mockImplementation(async () => new Map([['video', {
      id: 'video', type: 'inbound-rtp', kind: 'video',
      bytesReceived: ++frames * 4096, framesDecoded: frames,
    }]]) as unknown as RTCStatsReport);
    await vi.advanceTimersByTimeAsync(8_000);
    const receiver = FakePeerConnection.instances[0];
    receiver.connectionState = 'connected';
    receiver.onconnectionstatechange?.call(receiver as unknown as RTCPeerConnection, new Event('connectionstatechange'));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(sent.some(signal => signal.type === 'signal'
      && signal.transport === 'native-screen'
      && signal.data.kind === 'native-screen-fallback-request')).toBe(false);
    vi.useRealTimers();
  });

  it('moves a viewer whose link cannot sustain the fixed native bitrate to the compatibility route', async () => {
    vi.useFakeTimers();
    // Receiving, so the no-media timer never fires, but losing far more than
    // NACK can retransmit. The native sender has no way to encode any slower.
    let lost = 0, received = 0;
    const advance = () => {
      lost += 90;
      received += 910;
      FakePeerConnection.stats = new Map([['video', {
        id: 'video', type: 'inbound-rtp', kind: 'video',
        bytesReceived: received * 1200, framesDecoded: received,
        packetsReceived: received, packetsLost: lost, totalFreezesDuration: 0,
      }]]);
    };
    advance();
    const { transport, sent } = setup();
    await transport.handle({
      type: 'offer', from: 'peer-b', to: 'self', transport: 'native-screen',
      captureId: 'remote-capture', description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    const requested = () => sent.some(signal => signal.type === 'signal'
      && signal.transport === 'native-screen'
      && signal.data.kind === 'native-screen-fallback-request');
    // The first window only establishes a baseline, and one bad window is a
    // hiccup, so neither may move a viewer off the native route.
    for (let window = 0; window < 2; window += 1) {
      advance();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(requested()).toBe(false);
    }
    for (let window = 0; window < 3; window += 1) {
      advance();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(requested()).toBe(true);
    vi.useRealTimers();
  });

  it('keeps a viewer on the native route through an isolated bad window', async () => {
    vi.useFakeTimers();
    let lost = 0, received = 0;
    const advance = (lossPackets: number) => {
      lost += lossPackets;
      received += 1000 - lossPackets;
      FakePeerConnection.stats = new Map([['video', {
        id: 'video', type: 'inbound-rtp', kind: 'video',
        bytesReceived: received * 1200, framesDecoded: received,
        packetsReceived: received, packetsLost: lost, totalFreezesDuration: 0,
      }]]);
    };
    advance(0);
    const { transport, sent } = setup();
    await transport.handle({
      type: 'offer', from: 'peer-b', to: 'self', transport: 'native-screen',
      captureId: 'remote-capture', description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    for (const loss of [0, 90, 90, 0, 90, 90, 0]) {
      advance(loss);
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(sent.some(signal => signal.type === 'signal'
      && signal.transport === 'native-screen'
      && signal.data.kind === 'native-screen-fallback-request')).toBe(false);
    vi.useRealTimers();
  });

  for (const failure of ['no decoded frames', 'stalled decoded frames', 'sustained loss']) {
    it(`requests camera fallback and releases the receiver on ${failure}`, async () => {
      vi.useFakeTimers();
      const { transport, sent, removed, ended } = setup(false, true);
      await transport.handle({
        type: 'offer', from: 'phone', to: 'self', transport: 'native-screen',
        captureId: 'camera', description: { type: 'offer', sdp: 'v=0\r\n' },
      });
      const receiver = FakePeerConnection.instances[0];
      let reads = 0;
      receiver.getStats.mockImplementation(async () => new Map([['video', {
        type: 'inbound-rtp', kind: 'video', bytesReceived: ++reads * 4096,
        framesDecoded: failure === 'no decoded frames' ? 0 : failure === 'stalled decoded frames' ? 1 : reads,
        packetsReceived: reads * 910, packetsLost: failure === 'sustained loss' ? reads * 90 : 0,
      }]]) as unknown as RTCStatsReport);
      receiver.connectionState = 'connected';
      receiver.onconnectionstatechange?.call(receiver as unknown as RTCPeerConnection, new Event('connectionstatechange'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent.filter(signal => signal.type === 'signal')).toEqual([expect.objectContaining({
        captureId: 'camera', data: { kind: 'native-screen-fallback-request', captureId: 'camera' },
      })]);
      expect(receiver.close).toHaveBeenCalledOnce();
      expect(removed).toHaveBeenCalledWith('phone');
      expect(ended).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });
  }

  it('releases a failed camera receiver even when fallback signaling fails', async () => {
    vi.useFakeTimers();
    const { transport, signaling, removed } = setup(false, true);
    await transport.handle({
      type: 'offer', from: 'phone', to: 'self', transport: 'native-screen',
      captureId: 'camera', description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    vi.mocked(signaling.send).mockRejectedValue(new Error('Socket closed'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakePeerConnection.instances[0].close).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith('phone');
    expect(vi.getTimerCount()).toBe(1);
    transport.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('retries the camera fallback notification after signaling recovers, even after the track ends', async () => {
    vi.useFakeTimers();
    const { transport, signaling } = setup(false, true);
    await transport.handle({ type: 'offer', from: 'phone', to: 'self', transport: 'native-screen',
      captureId: 'camera', description: { type: 'offer', sdp: 'v=0\r\n' } });
    const receiver = FakePeerConnection.instances[0];
    const track = Object.assign(new EventTarget(), { kind: 'video', id: 'native-camera' });
    receiver.ontrack?.call(receiver as unknown as RTCPeerConnection, { track } as unknown as RTCTrackEvent);
    receiver.close.mockImplementation(() => track.dispatchEvent(new Event('ended')));
    vi.mocked(signaling.send).mockRejectedValueOnce(new Error('Socket reconnecting'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(receiver.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signaling.send).toHaveBeenLastCalledWith(expect.objectContaining({
      captureId: 'camera', data: { kind: 'native-screen-fallback-request', captureId: 'camera' },
    }));
    expect(vi.mocked(signaling.send).mock.calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('bounds fallback notification retries when signaling never recovers', async () => {
    vi.useFakeTimers();
    const { transport, signaling, ended } = setup(false, true);
    await transport.handle({ type: 'offer', from: 'phone', to: 'self', transport: 'native-screen',
      captureId: 'camera', description: { type: 'offer', sdp: 'v=0\r\n' } });
    vi.mocked(signaling.send).mockRejectedValue(new Error('Socket closed'));
    await vi.advanceTimersByTimeAsync(41_000);
    expect(ended).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledWith(expect.stringContaining('Rejoin the call'));
    expect(vi.getTimerCount()).toBe(0);
    const attempts = vi.mocked(signaling.send).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(signaling.send).mock.calls).toHaveLength(attempts);
    vi.useRealTimers();
  });

  for (const action of ['remove peer', 'replace capture']) {
    it(`cancels old camera fallback notification retries on ${action}`, async () => {
      vi.useFakeTimers();
      const { transport, signaling } = setup(false, true);
      const offer = { type: 'offer' as const, from: 'phone', to: 'self', transport: 'native-screen' as const,
        captureId: 'camera', description: { type: 'offer' as const, sdp: 'v=0\r\n' } };
      await transport.handle(offer);
      vi.mocked(signaling.send).mockRejectedValueOnce(new Error('Socket reconnecting'));
      await vi.advanceTimersByTimeAsync(20_000);
      const attempts = () => vi.mocked(signaling.send).mock.calls.filter(([signal]) =>
        signal.type === 'signal' && signal.transport === 'native-screen' && signal.captureId === 'camera').length;
      const before = attempts();
      if (action === 'remove peer') await transport.removePeer('phone');
      else await transport.handle({ ...offer, captureId: 'new-camera' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts()).toBe(before);
      transport.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });
  }

  it('publishes a requested compatibility fallback and removes the failed native sender peer', async () => {
    const { transport, fallback } = setup();
    await transport.start({
      sourceId: 'window:opaque', encoder: 'h264_nvenc', width: 1920,
      height: 1080, fps: 60, bitrateMbps: 20, cursor: true,
    });
    await transport.addPeer('peer-b');
    await transport.handle({
      type: 'signal', from: 'peer-b', to: 'self', transport: 'native-screen',
      captureId: 'capture-1',
      data: { kind: 'native-screen-fallback-request', captureId: 'capture-1' },
    });
    expect(fallback).toHaveBeenCalledWith('peer-b');
    expect(mocks.invoke).toHaveBeenCalledWith('native_screen_peer_remove', {
      sessionId: 'capture-1', peerId: 'peer-b',
    });
  });

  it('cleans up a native session that resolves after cancellation', async () => {
    let resolveStart!: (value: unknown) => void;
    mocks.invoke.mockImplementation(
      (command: string, _args: Record<string, unknown>) => {
        if (command === 'native_screen_start')
          return new Promise((resolve) => {
            resolveStart = resolve;
          });
        return Promise.resolve(null);
      },
    );
    const { transport } = setup();
    const starting = transport.start({
      sourceId: 'monitor:opaque',
      encoder: 'h264_qsv',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateMbps: 20,
      cursor: false,
    });
    await transport.stop();
    await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
    resolveStart({ sessionId: 'late-session' });
    await starting;
    expect(mocks.invoke).toHaveBeenCalledWith('native_screen_stop', {
      sessionId: 'late-session',
    });
    expect(transport.active).toBe(false);
  });

  it('does not signal an outbound offer that resolves after the share stopped', async () => {
    vi.useFakeTimers();
    let resolveOffer!: (value: RTCSessionDescriptionInit) => void;
    mocks.invoke.mockImplementation(
      (command: string, args: Record<string, unknown>) => {
        if (command === 'native_screen_start')
          return Promise.resolve({ ...args, sessionId: 'capture-1' });
        if (command === 'native_screen_peer_offer' && args.peerId === 'peer-late')
          return new Promise((resolve) => { resolveOffer = resolve; });
        if (command === 'native_screen_peer_offer')
          return Promise.resolve({ type: 'offer', sdp: `offer-${args.peerId}` });
        return Promise.resolve(null);
      },
    );
    const { transport, sent } = setup();
    await transport.start({
      sourceId: 'monitor:opaque', encoder: 'h264_qsv', width: 1920,
      height: 1080, fps: 30, bitrateMbps: 20, cursor: false,
    });
    const adding = transport.addPeer('peer-late');
    await vi.advanceTimersByTimeAsync(1_000);
    await transport.stop();
    resolveOffer({ type: 'offer', sdp: 'stale-offer' });
    await adding;
    expect(sent.some((signal) => signal.type === 'offer' && signal.to === 'peer-late')).toBe(false);
    vi.useRealTimers();
  });

  it('closes a receiver disposed while its asynchronous offer is being applied', async () => {
    let release!: () => void;
    FakePeerConnection.remoteDescriptionGate = new Promise<void>((resolve) => { release = resolve; });
    const { transport, sent, removed } = setup();
    const handling = transport.handle({
      type: 'offer', from: 'peer-late', to: 'self', transport: 'native-screen',
      captureId: 'capture-late', description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await Promise.resolve();
    const receiver = FakePeerConnection.instances[0];
    transport.dispose();
    release();
    await handling;
    expect(receiver.close).toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith('peer-late');
    expect(sent.some((signal) => signal.type === 'answer')).toBe(false);
  });

  it('reserves pending peers, enforces the native 7-peer limit, and preserves receivers on local stop', async () => {
    vi.useFakeTimers();
    const { transport, removed } = setup();
    await transport.start({
      sourceId: 'window:opaque',
      encoder: 'libx264',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateMbps: 10,
      cursor: true,
    });
    await transport.handle({
      type: 'offer',
      from: 'viewer',
      to: 'self',
      transport: 'native-screen',
      captureId: 'incoming',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    const duplicate = Promise.all([
      transport.addPeer('peer-1'),
      transport.addPeer('peer-1'),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await duplicate;
    expect(
      mocks.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'native_screen_peer_offer' && args.peerId === 'peer-1',
      ),
    ).toHaveLength(1);
    for (let number = 2; number <= 7; number++) {
      const adding = transport.addPeer(`peer-${number}`);
      await vi.advanceTimersByTimeAsync(1_000);
      await adding;
    }
    await expect(transport.addPeer('peer-8')).rejects.toThrow(/up to 7/);

    const receiver = FakePeerConnection.instances[1];
    await transport.stop();
    expect(receiver.close).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalledWith('viewer');
    vi.useRealTimers();
  });

  it('queues receiver ICE before its offer and removes relay routes in direct-only mode', async () => {
    const { transport } = setup(true);
    await transport.handle({
      type: 'ice-candidate',
      from: 'peer-c',
      to: 'self',
      transport: 'native-screen',
      captureId: 'capture-c',
      candidate: { candidate: 'candidate:relay 1 udp 1 1.2.3.4 9 typ relay' },
    });
    await transport.handle({
      type: 'ice-candidate',
      from: 'peer-c',
      to: 'self',
      transport: 'native-screen',
      captureId: 'capture-c',
      candidate: { candidate: 'candidate:host 1 udp 1 10.0.0.1 9 typ host' },
    });
    await transport.handle({
      type: 'offer',
      from: 'peer-c',
      to: 'self',
      transport: 'native-screen',
      captureId: 'capture-c',
      description: {
        type: 'offer',
        sdp: 'v=0\r\na=candidate:1 1 udp 1 1.2.3.4 9 typ relay\r\na=candidate:2 1 udp 1 10.0.0.1 9 typ host\r\n',
      },
    });
    const receiver = FakePeerConnection.instances[0];
    expect(receiver.remoteDescription?.sdp).not.toContain('typ relay');
    expect(receiver.remoteDescription?.sdp).toContain('typ host');
    expect(receiver.addIceCandidate).toHaveBeenCalledTimes(1);
    expect(receiver.addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.stringContaining('typ host'),
      }),
    );
  });

  it('keeps a receiver open for unknown native control signals', async () => {
    const { transport, removed } = setup();
    await transport.handle({
      type: 'offer', from: 'peer-b', to: 'self', transport: 'native-screen',
      captureId: 'capture-b', description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    const receiver = FakePeerConnection.instances[0];
    await expect(transport.handle({
      type: 'signal', from: 'peer-b', to: 'self', transport: 'native-screen',
      captureId: 'capture-b', data: { kind: 'future-native-screen-message' },
    } as unknown as MediaSignal)).resolves.toBe(true);
    expect(receiver.close).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  it('reports receiver video counters and codec without exposing the peer connection', async () => {
    FakePeerConnection.stats = new Map([
      ['video', {
        id: 'video', type: 'inbound-rtp', kind: 'video', codecId: 'codec',
        bytesReceived: 8192, framesDecoded: 37, packetsLost: 2,
      }],
      ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264' }],
    ]);
    const { transport } = setup();
    await transport.handle({
      type: 'offer', from: 'peer-stats', to: 'self', transport: 'native-screen',
      captureId: 'capture-stats', description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    FakePeerConnection.instances[0].connectionState = 'connected';
    await expect(transport.getReceiverStats('peer-stats')).resolves.toEqual({
      connectionState: 'connected', bytesReceived: 8192, framesDecoded: 37,
      packetsLost: 2, codec: 'video/H264',
    });
    await expect(transport.getReceiverStats('unknown')).resolves.toBeUndefined();
  });

  it('bounds pending candidates and receive-only peer connections', async () => {
    const { transport } = setup();
    const candidate = {
      type: 'ice-candidate' as const,
      from: 'pending-peer',
      to: 'self',
      transport: 'native-screen' as const,
      captureId: 'pending-capture',
      candidate: { candidate: 'candidate:host 1 udp 1 10.0.0.1 9 typ host' },
    };
    for (let number = 0; number < 256; number++)
      await transport.handle(candidate);
    await expect(transport.handle(candidate)).rejects.toThrow(/Too many queued/);

    for (let number = 0; number < 16; number++)
      await transport.handle({
        type: 'offer', from: `sender-${number}`, to: 'self',
        transport: 'native-screen', captureId: `capture-${number}`,
        description: { type: 'offer', sdp: 'v=0\r\n' },
      });
    await expect(transport.handle({
      type: 'offer', from: 'sender-16', to: 'self', transport: 'native-screen',
      captureId: 'capture-16', description: { type: 'offer', sdp: 'v=0\r\n' },
    })).rejects.toThrow(/Too many native screen receivers/);
  });
});

it('bounds retained diagnostics and replaces peer identifiers with local aliases', async () => {
  const { transport } = setup();
  for (let index = 0; index < 300; index++) transport.noteSignalFailure({ type: 'offer', from: 'private-peer-id', to: 'self', transport: 'native-screen', captureId: 'private-capture', description: { type: 'offer', sdp: 'private-sdp-with-ip' } });
  const report = await transport.getDiagnostics();
  expect(report.events).toHaveLength(200);
  expect(report.events.every(event => event.peer === 1 && event.event === 'signal-failed')).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(/private-peer|private-capture|private-sdp|example.test/);
});

it('uses an injected native camera sender without creating a webview preview peer', async () => {
  const invoke = vi.fn().mockResolvedValue({ sessionId: 'camera-session', fps: 30, bitrateMbps: 3 });
  const unlisten = vi.fn();
  const transport = new NativeScreenTransport({ localPeerId: 'self', send: vi.fn() }, [], false,
    vi.fn(), vi.fn(), vi.fn(), vi.fn(), undefined, {
      invoke, listen: vi.fn().mockResolvedValue(unlisten), externalPreview: true, closeReceiverOnFallback: true,
    });
  await transport.start({ sourceId: 'meta-camera', encoder: 'libx264', width: 720, height: 1280,
    fps: 30, bitrateMbps: 3, cursor: false, h264Profile: 'baseline' }, []);
  expect(transport.active).toBe(true);
  expect(FakePeerConnection.instances).toHaveLength(0);
  expect(mocks.invoke).not.toHaveBeenCalled();
  await transport.stop();
  expect(invoke).toHaveBeenCalledWith('native_screen_stop', { sessionId: 'camera-session' });
  expect(unlisten).toHaveBeenCalledOnce();
  expect(transport.active).toBe(false);
});

it('probes only participants whose client answers the capability query', async () => {
  const send = vi.fn();
  const transport = new NativeScreenTransport({ localPeerId: 'self', send }, [], false,
    vi.fn(), vi.fn(), vi.fn(), vi.fn());
  const probe = transport.probePeers(['new-client', 'old-client', 'self'], 50);
  expect(send.mock.calls.map(([signal]) => signal.to)).toEqual(['new-client', 'old-client']);
  const nonce = send.mock.calls[0][0].data.nonce;
  await transport.handle({ type: 'signal', from: 'new-client', transport: 'native-screen', captureId: nonce,
    data: { kind: 'native-screen-profile-reply', nonce, profiles: ['baseline'], runtime: 'browser' } } as never);
  // The old client never replies; the probe still settles at its timeout.
  await expect(probe).resolves.toEqual(new Set(['new-client']));
});

it('does not report a native camera interruption while video is arriving', async () => {
  const onEnded = vi.fn();
  const transport = new NativeScreenTransport({ localPeerId: 'self', send: vi.fn() }, [], false,
    vi.fn(), vi.fn(), onEnded, vi.fn(), undefined, {
      invoke: vi.fn(), listen: vi.fn(), externalPreview: true, closeReceiverOnFallback: true,
    });
  const receivers = (transport as unknown as { receivers: Map<string, unknown> }).receivers;
  receivers.set('phone', { captureId: 'camera', fallbackRequested: false, badWindows: 0,
    pc: { getStats: async () => new Map([['v', { type: 'inbound-rtp', kind: 'video', bytesReceived: 4096 }]]) } });
  await (transport as unknown as { requestReceiverFallback(peer: string, capture: string, reason: string): Promise<void> })
    .requestReceiverFallback('phone', 'camera', 'no-media-timeout');
  expect(onEnded).not.toHaveBeenCalled();
});

it('cancels a host start that is still waiting when sharing stops', async () => {
  let finish!: (session: unknown) => void;
  const invoke = vi.fn((command: string) => command === 'native_screen_start'
    ? new Promise((resolve) => { finish = resolve; })
    : Promise.resolve(undefined));
  const cancelPending = vi.fn().mockResolvedValue(undefined);
  const transport = new NativeScreenTransport({ localPeerId: 'self', send: vi.fn() }, [], false,
    vi.fn(), vi.fn(), vi.fn(), vi.fn(), undefined, {
      invoke: invoke as never, listen: vi.fn().mockResolvedValue(vi.fn()), externalPreview: true, cancelPending,
    });
  const start = transport.start({ sourceId: 'ios-broadcast', encoder: 'libx264', width: 720, height: 1280,
    fps: 30, bitrateMbps: 3, cursor: false, h264Profile: 'baseline' }, []);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('native_screen_start', expect.anything()));
  // Leaving the call while the iOS picker is open.
  await transport.stop();
  expect(cancelPending).toHaveBeenCalledOnce();
  // A start that completes anyway is stopped rather than published.
  finish({ sessionId: 'late', fps: 30, bitrateMbps: 3 });
  await start;
  expect(transport.active).toBe(false);
  expect(invoke).toHaveBeenCalledWith('native_screen_stop', { sessionId: 'late' });
});

it('renews active native sender and receiver credentials without restarting capture', async () => {
  const { transport } = setup();
  await transport.start({ sourceId: 'test', encoder: 'libx264', width: 1280, height: 720, fps: 30, bitrateMbps: 8, cursor: true });
  await transport.handle({ type: 'offer', from: 'viewer', to: 'self', transport: 'native-screen', captureId: 'other', description: { type: 'offer', sdp: 'offer' } });
  const connections = [...FakePeerConnection.instances];
  const servers = [{ urls: ['turn:relay.example.test'], username: 'renewed', credential: 'fixture-only' }];
  transport.setIceServers(servers);
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('native_screen_ice_servers', { sessionId: 'capture-1', iceServers: servers }));
  expect(connections.at(-1)?.getConfiguration().iceServers).toEqual(servers);
  expect(connections.at(-1)?.close).not.toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'native_screen_start')).toHaveLength(1);
  await transport.dispose();
});

it('credential renewal preserves direct-only filtering on both ends', async () => {
  const { transport } = setup(true, true);
  await transport.start({ sourceId: 'test', encoder: 'libx264', width: 1280, height: 720, fps: 30, bitrateMbps: 8, cursor: true });
  await transport.handle({ type: 'offer', from: 'viewer', to: 'self', transport: 'native-screen', captureId: 'other', description: { type: 'offer', sdp: 'offer' } });
  transport.setIceServers([{ urls: ['stun:stun.example.test', 'turn:relay.example.test'], username: 'renewed', credential: 'fixture-only' }]);
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('native_screen_ice_servers', { sessionId: 'capture-1', iceServers: [{ urls: ['stun:stun.example.test'], username: 'renewed', credential: 'fixture-only' }] }));
  expect(FakePeerConnection.instances.at(-1)?.getConfiguration().iceServers).toEqual([{ urls: ['stun:stun.example.test'], username: 'renewed', credential: 'fixture-only' }]);
  await transport.dispose();
});
