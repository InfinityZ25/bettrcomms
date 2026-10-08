import { NativeScreenTransport } from './nativeScreen';
import { callIOSMetaSender } from '../desktop/iosNativeBindings';
import { hasMetaGlassesCamera } from './metaGlassesCamera';
import type { MediaSignal, SignalingAdapter } from './types';

/** Separate camera transport: never shares screen capture IDs, tracks, or stops. */
export class NativeCameraTransport {
  private transport: NativeScreenTransport;
  private readonly peerAttempts = new Map<string, AbortController>();
  private readonly onSignalingDisconnected = () => this.trace('signaling-disconnected');
  private readonly onSignalingReconnected = () => this.trace('signaling-reconnected');
  private readonly onSignalingError = (event: Event) => {
    const code = (event as CustomEvent<{ code?: string }>).detail?.code;
    this.trace(`signaling-error ${code ?? 'unknown'}`);
  };
  constructor(private readonly signaling: SignalingAdapter, iceServers: RTCIceServer[], directOnly: boolean,
    onRemote: (peerId: string, track: MediaStreamTrack) => void,
    onRemoved: (peerId: string) => void, onError: (reason: string) => void) {
    // Signal types only: never SDP, candidates, or peer identifiers.
    this.trace = hasMetaGlassesCamera()
      ? (event) => void callIOSMetaSender('native_camera_trace', { event }).catch(() => undefined)
      : () => undefined;
    (signaling as Partial<EventTarget>).addEventListener?.('error', this.onSignalingError);
    (signaling as Partial<EventTarget>).addEventListener?.('disconnected', this.onSignalingDisconnected);
    (signaling as Partial<EventTarget>).addEventListener?.('reconnected', this.onSignalingReconnected);
    this.transport = new NativeScreenTransport({
      localPeerId: signaling.localPeerId,
      send: async (signal) => {
        this.trace(`send ${signal.type} ${signalKind(signal)}`);
        try { await signaling.send({ ...signal, transport: 'native-camera' } as MediaSignal); }
        catch (error) { this.trace(`send-failed ${signal.type}`); throw error; }
      },
    }, iceServers, directOnly, () => {}, onRemote, onRemoved, onError,
    async (peerId) => {
      this.trace('peer-media-failed');
      await this.transport.endOutboundPeer(peerId);
    }, {
      invoke: callIOSMetaSender,
      externalPreview: true,
      closeReceiverOnFallback: true,
      listen: async (_listener) => {
        const handler = (event: Event) => {
          const detail = (event as CustomEvent<{kind: string; message?: string}>).detail;
          if (detail?.kind === 'error') onError(detail.message ?? 'Glasses camera stopped.');
          if (detail?.kind === 'stopped') void this.stop();
        };
        window.addEventListener('bc-meta-camera', handler);
        return () => window.removeEventListener('bc-meta-camera', handler);
      },
    });
  }
  readonly trace: (event: string) => void;
  get active() { return this.transport.active; }
  setIceServers(iceServers: RTCIceServer[]) { this.transport.setIceServers(iceServers); }
  async start() {
    await this.transport.start({ sourceId: 'meta-camera', encoder: 'libx264', width: 720,
      height: 1280, fps: 30, bitrateMbps: 3, cursor: false, h264Profile: 'baseline', contentHint: 'motion' });
  }

  /**
   * Try the native stream for one participant. Resolves false when that client
   * cannot receive it (older desktop apps drop native-camera signals without a
   * reply) or the connection does not complete, so the caller keeps sending the
   * ordinary call camera to them instead of leaving them without video.
   */
  async connectPeer(peerId: string): Promise<boolean> {
    const sessionId = this.transport.sessionId;
    if (!sessionId) return false;
    this.peerAttempts.get(peerId)?.abort();
    const attempt = new AbortController();
    this.peerAttempts.set(peerId, attempt);
    const current = () => !attempt.signal.aborted && this.transport.sessionId === sessionId
      && this.peerAttempts.get(peerId) === attempt;
    try {
      const probeDeadline = Date.now() + PROBE_RETRY_WINDOW_MS;
      let supported = false;
      while (current() && Date.now() < probeDeadline) {
        supported = (await this.transport.probePeers([peerId],
          Math.min(PROBE_TIMEOUT_MS, probeDeadline - Date.now()))).has(peerId);
        if (!current()) return false;
        if (supported) break;
        if (Date.now() >= probeDeadline) break;
        this.trace('peer-probe-retry');
        await waitForRetry(Math.min(PROBE_RETRY_DELAY_MS, Math.max(0, probeDeadline - Date.now())), attempt.signal);
      }
      if (!current()) return false;
      if (!supported) {
        this.trace('peer-no-capability-reply');
        return false;
      }
      await this.transport.addPeer(peerId);
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await waitForRetry(500, attempt.signal);
        if (!current() || !this.transport.hasOutboundPeer(peerId)) return false;
        const state = await callIOSMetaSender<{ connected?: boolean }>('native_screen_peer_connected',
          { sessionId, peerId }).catch(() => undefined);
        if (!current()) return false;
        if (state?.connected) {
          this.trace('peer-connected');
          return true;
        }
      }
      this.trace('peer-connect-timeout');
      await this.transport.endOutboundPeer(peerId);
      return false;
    } finally {
      if (this.peerAttempts.get(peerId) === attempt) this.peerAttempts.delete(peerId);
    }
  }

  /** Resolves once a connected participant has stayed disconnected for several seconds. */
  async waitForPeerLoss(peerId: string): Promise<void> {
    const sessionId = this.transport.sessionId;
    let misses = 0;
    while (sessionId && this.transport.sessionId === sessionId) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // Receiver-reported media failure removes the native peer immediately,
      // even if ICE was still connected. Let the engine restore its call camera.
      if (this.transport.sessionId !== sessionId || !this.transport.hasOutboundPeer(peerId)) return;
      const state = await callIOSMetaSender<{ connected?: boolean }>('native_screen_peer_connected',
        { sessionId, peerId }).catch(() => undefined);
      misses = state?.connected ? 0 : misses + 1;
      if (misses >= 3) {
        this.trace('peer-lost');
        await this.transport.endOutboundPeer(peerId);
        return;
      }
    }
  }

  async handle(signal: MediaSignal) {
    this.trace(`recv ${signal.type} ${signalKind(signal)}`);
    try { return await this.transport.handle({ ...signal, transport: 'native-screen' } as MediaSignal); }
    catch (error) { this.trace(`recv-failed ${signal.type}`); throw error; }
  }
  removePeer(id: string) {
    this.peerAttempts.get(id)?.abort();
    this.peerAttempts.delete(id);
    return this.transport.removePeer(id);
  }
  stop() { this.cancelPeerAttempts(); return this.transport.stop(); }
  dispose() {
    this.cancelPeerAttempts();
    (this.signaling as Partial<EventTarget>).removeEventListener?.('error', this.onSignalingError);
    (this.signaling as Partial<EventTarget>).removeEventListener?.('disconnected', this.onSignalingDisconnected);
    (this.signaling as Partial<EventTarget>).removeEventListener?.('reconnected', this.onSignalingReconnected);
    this.transport.dispose();
  }
  private cancelPeerAttempts() {
    for (const attempt of this.peerAttempts.values()) attempt.abort();
    this.peerAttempts.clear();
  }
  getDiagnostics() { return this.transport.getDiagnostics(); }
}

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_RETRY_WINDOW_MS = 30_000;
const PROBE_RETRY_DELAY_MS = 1_000;
const CONNECT_TIMEOUT_MS = 15_000;

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

const signalKind = (signal: MediaSignal) =>
  signal.type === 'signal' ? String((signal.data as { kind?: unknown } | undefined)?.kind ?? '').slice(0, 40) : '';
