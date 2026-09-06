import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  relayInstances: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
}));

vi.mock('./voiceRelay', () => ({
  VoiceRelay: class {
    start = vi.fn(async () => undefined);
    stop = vi.fn();
    dispose = vi.fn();
    setMicrophone = vi.fn();
    handleSignal = vi.fn(async () => undefined);
    getVerificationCode = vi.fn(async () => null);
    constructor() { mocks.relayInstances.push(this); }
  },
}));

vi.mock('./nativeScreen', () => ({
  NativeScreenTransport: class {
    active = false;
    addPeer = vi.fn();
    removePeer = vi.fn();
    handle = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock('./denoise', () => ({ createDenoiser: vi.fn() }));
vi.mock('./speexDenoise', () => ({ createSpeexDenoiser: vi.fn() }));
vi.mock('./nvidiaDenoise', () => ({ createNvidiaDenoiser: vi.fn() }));
vi.mock('./deepfilterDenoise', () => ({ createDeepfilterDenoiser: vi.fn() }));
vi.mock('./microphoneEffects', () => ({ createMicrophoneEffects: vi.fn() }));
vi.mock('./nativeSystemAudio', () => ({ createNativeSystemAudio: vi.fn() }));
vi.mock('./recording', () => ({ TrackRecordingSession: class {} }));
vi.mock('./audio', () => ({ AudioLeveler: class {} }));

import { MediaEngine } from './engine';
import type { MediaSignal, SignalingAdapter } from './types';

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  remoteDescription: RTCSessionDescription | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: (() => void) | null = null;
  ontrack: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  close = vi.fn();
  restartIce = vi.fn();
  addTrack = vi.fn();
  constructor() { FakePeerConnection.instances.push(this); }
}

function setup(mode: 'direct-only' | 'direct-preferred' = 'direct-preferred') {
  const sent: MediaSignal[] = [];
  const signaling: SignalingAdapter = {
    localPeerId: 'z-local',
    send: vi.fn(async (signal) => { sent.push(signal); }),
  };
  const engine = new MediaEngine({
    signaling,
    ice: { mode },
    voiceRelay: { url: 'ws://relay.test', mode: 'automatic' },
  });
  return { engine, sent, relay: mocks.relayInstances.at(-1) };
}

function routeSignal(kind: string, nonce?: string): MediaSignal {
  return {
    type: 'signal', transport: 'voice-relay', from: 'a-peer', to: 'z-local',
    data: { kind, ...(nonce ? { nonce } : {}) },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  FakePeerConnection.instances = [];
  mocks.relayInstances.length = 0;
});

describe('voice route recovery', () => {
  it('stops fallback only for the current stable-path probe nonce', async () => {
    const { engine, sent, relay } = setup();
    engine.addPeer('a-peer');
    const pc = FakePeerConnection.instances[0];
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(5_000);
    const probe = [...sent].reverse().find((signal) => signal.type === 'signal' && signal.data.kind === 'direct-probe');
    if (probe?.type !== 'signal' || probe.transport !== 'voice-relay') throw new Error('Missing readiness probe');
    expect(probe.data.nonce).toEqual(expect.any(String));

    await engine.handleSignal(routeSignal('direct-ready', 'stale'));
    expect(relay!.stop).not.toHaveBeenCalled();
    await engine.handleSignal(routeSignal('direct-ready', probe.data.nonce as string));
    expect(relay!.stop).toHaveBeenCalledWith('a-peer');
    engine.dispose();
  });

  it('restarts relay after remote unready while local RTC stays connected', async () => {
    const { engine, relay } = setup();
    engine.addPeer('a-peer');
    const pc = FakePeerConnection.instances[0];
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    await engine.handleSignal(routeSignal('direct-unready'));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(relay!.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(relay!.start).toHaveBeenCalledWith('a-peer');
    engine.dispose();
  });

  it('does not construct or accept relay routing in direct-only mode', async () => {
    const { engine } = setup('direct-only');
    expect(mocks.relayInstances).toHaveLength(0);
    engine.addPeer('a-peer');
    await engine.handleSignal(routeSignal('direct-unready'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.relayInstances).toHaveLength(0);
    engine.dispose();
  });

  it('remove and dispose cancel stable and fallback timers', async () => {
    const first = setup();
    first.engine.addPeer('a-peer');
    const firstPc = FakePeerConnection.instances.at(-1)!;
    firstPc.connectionState = 'connected';
    firstPc.onconnectionstatechange?.();
    first.engine.removePeer('a-peer');

    const second = setup();
    second.engine.addPeer('a-peer');
    second.engine.dispose();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(first.relay!.start).not.toHaveBeenCalled();
    expect(second.relay!.start).not.toHaveBeenCalled();
    expect(first.sent.some((signal) => signal.type === 'signal' && signal.data.kind === 'direct-probe')).toBe(false);
    expect(second.sent.some((signal) => signal.type === 'signal' && signal.data.kind === 'direct-probe')).toBe(false);
    expect(firstPc.close).toHaveBeenCalledOnce();
  });
});
