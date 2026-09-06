import { beforeEach, describe, expect, it, vi } from 'vitest';

const codec = vi.hoisted(() => ({
  encoders: [] as Array<{
    packet(data: Uint8Array): void;
    dispose: ReturnType<typeof vi.fn>;
    rates: number[];
  }>,
  decoders: [] as Array<{
    push: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    track: MediaStreamTrack;
  }>,
  rejectEncoder: false,
}));

vi.mock('./voiceCodec', () => ({
  createVoiceEncoder: vi.fn(async (_track, onPacket) => {
    if (codec.rejectEncoder) throw new Error('encoder unsupported');
    const value = { packet: onPacket, dispose: vi.fn(), rates: [] as number[] };
    codec.encoders.push(value);
    return {
      dispose: value.dispose,
      setBitrate: (rate: number) => value.rates.push(rate),
    };
  }),
  createVoiceDecoder: vi.fn(async () => {
    const value = {
      push: vi.fn(),
      dispose: vi.fn(),
      track: { kind: 'audio', readyState: 'live' } as MediaStreamTrack,
    };
    codec.decoders.push(value);
    return { ...value, stream: {} as MediaStream };
  }),
}));

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  static initialReadyState = FakeSocket.OPEN;
  readyState = FakeSocket.initialReadyState;
  bufferedAmount = 0;
  sent: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  message(value: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(value) }),
    );
  }
}

describe('VoiceRelay', () => {
  beforeEach(() => {
    codec.encoders.length = 0;
    codec.decoders.length = 0;
    FakeSocket.instances.length = 0;
    FakeSocket.initialReadyState = FakeSocket.OPEN;
    codec.rejectEncoder = false;
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  it('resolves glare deterministically, encrypts media, and exposes a track after authenticated audio', async () => {
    const { VoiceRelay } = await import('./voiceRelay');
    const aliceTracks = vi.fn();
    const bobTracks = vi.fn();
    let alice!: InstanceType<typeof VoiceRelay>;
    let bob!: InstanceType<typeof VoiceRelay>;
    const bobSignals: unknown[] = [];
    alice = new VoiceRelay({
      localPeerId: 'alice',
      url: 'wss://relay.test/voice',
      onTrack: aliceTracks,
      onState: vi.fn(),
      sendSignal: async (signal) =>
        bob.handleSignal({ ...signal, from: 'alice' }),
    });
    bob = new VoiceRelay({
      localPeerId: 'bob',
      url: 'wss://relay.test/voice',
      onTrack: bobTracks,
      onState: vi.fn(),
      sendSignal: async (signal) => {
        bobSignals.push(signal);
        await alice.handleSignal({ ...signal, from: 'bob' });
      },
    });
    alice.setMicrophone({
      kind: 'audio',
      readyState: 'live',
    } as MediaStreamTrack);
    bob.setMicrophone({
      kind: 'audio',
      readyState: 'live',
    } as MediaStreamTrack);
    await Promise.all([alice.start('bob'), bob.start('alice')]);
    await vi.waitFor(() => expect(codec.encoders).toHaveLength(2));
    expect(await alice.getVerificationCode('bob')).toBe(
      await bob.getVerificationCode('alice'),
    );
    const decoderCount = codec.decoders.length;
    const answer = bobSignals.find(
      (value) =>
        (value as { data?: { kind?: string } }).data?.kind === 'answer',
    );
    await alice.handleSignal({ ...(answer as object), from: 'bob' });
    expect(codec.decoders).toHaveLength(decoderCount);
    expect(bobTracks).not.toHaveBeenCalled();

    codec.encoders[0].packet(new Uint8Array([11, 22, 33]));
    await vi.waitFor(() =>
      expect(FakeSocket.instances[0].sent).toHaveLength(1),
    );
    const media = JSON.parse(FakeSocket.instances[0].sent[0]);
    expect(media.data).not.toContain('CxYh');
    FakeSocket.instances[1].message({ ...media, from: 'alice' });
    await vi.waitFor(() => expect(bobTracks).toHaveBeenCalledTimes(1));
    expect(codec.decoders[1].push).toHaveBeenCalledWith(
      new Uint8Array([11, 22, 33]),
      0,
    );

    FakeSocket.instances[0].bufferedAmount = 40 * 1024;
    codec.encoders[0].packet(new Uint8Array([44]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeSocket.instances[0].sent).toHaveLength(1);
    expect(codec.encoders[0].rates).toContain(32_000);
    alice.dispose();
    bob.dispose();
    expect(
      codec.encoders.every(
        (encoder) => encoder.dispose.mock.calls.length === 1,
      ),
    ).toBe(true);
  });

  it('answers ping and ignores malformed media without exposing tracks', async () => {
    const { VoiceRelay } = await import('./voiceRelay');
    const onTrack = vi.fn();
    const relay = new VoiceRelay({
      localPeerId: 'alice',
      url: 'wss://relay.test/voice',
      onTrack,
      onState: vi.fn(),
      sendSignal: vi.fn(),
    });
    await relay.start('bob');
    const socket = FakeSocket.instances[0];
    socket.message({ type: 'ping', request_id: 'request-1' });
    socket.message({
      type: 'voice',
      from: 'bob',
      epoch: 'wrong',
      sequence: 0,
      data: 'plaintext',
    });
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'pong',
      request_id: 'request-1',
    });
    expect(onTrack).not.toHaveBeenCalled();
    relay.dispose();
  });

  it('cleans up immediately when encoder creation fails', async () => {
    const { VoiceRelay } = await import('./voiceRelay');
    const states = vi.fn();
    let alice!: InstanceType<typeof VoiceRelay>;
    let bob!: InstanceType<typeof VoiceRelay>;
    alice = new VoiceRelay({
      localPeerId: 'alice',
      url: '/voice-relay',
      onTrack: vi.fn(),
      onState: states,
      sendSignal: async (signal) =>
        bob.handleSignal({ ...signal, from: 'alice' }),
    });
    bob = new VoiceRelay({
      localPeerId: 'bob',
      url: '/voice-relay',
      onTrack: vi.fn(),
      onState: vi.fn(),
      sendSignal: async (signal) =>
        alice.handleSignal({ ...signal, from: 'bob' }),
    });
    codec.rejectEncoder = true;
    alice.setMicrophone({
      kind: 'audio',
      readyState: 'live',
    } as MediaStreamTrack);
    await Promise.all([alice.start('bob'), bob.start('alice')]);
    await vi.waitFor(() =>
      expect(states).toHaveBeenCalledWith(
        'bob',
        'unavailable',
        'encoder unsupported',
      ),
    );
    expect(await alice.getVerificationCode('bob')).toBeNull();
    expect(
      codec.decoders.some((decoder) => decoder.dispose.mock.calls.length > 0),
    ).toBe(true);
    alice.dispose();
    bob.dispose();
  });

  it('bounds reconnects when a WebSocket never opens', async () => {
    vi.useFakeTimers();
    FakeSocket.initialReadyState = 0;
    const { VoiceRelay } = await import('./voiceRelay');
    const states = vi.fn();
    const relay = new VoiceRelay({
      localPeerId: 'alice',
      url: '/voice-relay',
      onTrack: vi.fn(),
      onState: states,
      sendSignal: vi.fn(),
    });
    await relay.start('bob');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(FakeSocket.instances.length).toBeLessThanOrEqual(4);
    expect(states).toHaveBeenCalledWith(
      'bob',
      'unavailable',
      'Voice relay connection is unavailable',
    );
    relay.dispose();
    vi.useRealTimers();
  });
});
