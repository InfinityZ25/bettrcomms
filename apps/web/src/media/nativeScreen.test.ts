import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

import { NativeScreenTransport } from './nativeScreen';
import type { MediaSignal, SignalingAdapter } from './types';

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
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
  addIceCandidate = vi.fn(async () => undefined);
}

function setup(directOnly = false) {
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
  const transport = new NativeScreenTransport(
    signaling,
    [{ urls: 'stun:example.test' }],
    directOnly,
    preview,
    remote,
    removed,
    ended,
  );
  return { transport, sent, preview, remote, removed };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  FakePeerConnection.instances = [];
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  mocks.invoke.mockReset();
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
    const query = sent.find((signal) => signal.type === 'signal')!;
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

  it('cleans up a native session that resolves after cancellation', async () => {
    let resolveStart!: (value: unknown) => void;
    mocks.invoke.mockImplementation(
      (command: string, args: Record<string, unknown>) => {
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
    resolveStart({ sessionId: 'late-session' });
    await starting;
    expect(mocks.invoke).toHaveBeenCalledWith('native_screen_stop', {
      sessionId: 'late-session',
    });
    expect(transport.active).toBe(false);
  });

  it('reserves pending peers, enforces the native 7-peer limit, and preserves receivers on local stop', async () => {
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
    await Promise.all([
      transport.addPeer('peer-1'),
      transport.addPeer('peer-1'),
    ]);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'native_screen_peer_offer' && args.peerId === 'peer-1',
      ),
    ).toHaveLength(1);
    for (let number = 2; number <= 7; number++)
      await transport.addPeer(`peer-${number}`);
    await expect(transport.addPeer('peer-8')).rejects.toThrow(/up to 7/);

    const receiver = FakePeerConnection.instances[1];
    await transport.stop();
    expect(receiver.close).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalledWith('viewer');
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
