import { createVoiceDecoder, createVoiceEncoder } from './voiceCodec';
import {
  createVoiceKeyPair,
  VoiceCryptoSession,
  type VoiceKeyPair,
} from './voiceCrypto';

export type VoiceRelayState = 'connecting' | 'relayed' | 'unavailable';
export type VoiceRelaySignal = {
  type: 'signal';
  transport: 'voice-relay';
  to: string;
  from?: string;
  data: {
    kind: 'ready' | 'offer' | 'answer' | 'stop';
    epoch?: string;
    publicKey?: string;
  };
};
export type VoiceRelayOptions = {
  localPeerId: string;
  url: string;
  sendSignal(signal: VoiceRelaySignal): void | Promise<void>;
  onTrack(peerId: string, track: MediaStreamTrack | null): void;
  onState(peerId: string, state: VoiceRelayState, message?: string): void;
};
type Encoder = Awaited<ReturnType<typeof createVoiceEncoder>>;
type Decoder = Awaited<ReturnType<typeof createVoiceDecoder>>;
type Peer = {
  wanted: boolean;
  generation: number;
  epoch?: string;
  keyPair?: VoiceKeyPair;
  crypto?: VoiceCryptoSession;
  encoder?: Encoder;
  encoderToken?: object;
  decoder?: Decoder;
  exposed: boolean;
  encrypting: number;
  decrypting: number;
  bitrate: number;
  phase: 'idle' | 'offering' | 'answering' | 'active';
  handshakeAttempts: number;
  handshakeTimer?: ReturnType<typeof setTimeout>;
};

const MAX_BUFFERED_BYTES = 32 * 1024;
const MAX_CRYPTO_JOBS = 1;
const NORMAL_BITRATE = 64_000;
const CONGESTED_BITRATE = 32_000;

function disposeSafely(resource: { dispose(): void } | undefined): void {
  try {
    resource?.dispose();
  } catch {
    // Teardown continues so one codec cannot retain the rest of the relay graph.
  }
}

function epoch(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function validPeer(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

export class VoiceRelay {
  private readonly peers = new Map<string, Peer>();
  private microphone: MediaStreamTrack | null = null;
  private socket: WebSocket | null = null;
  private socketGeneration = 0;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pendingPing?: string;
  private disposed = false;

  constructor(private readonly options: VoiceRelayOptions) {
    if (!validPeer(options.localPeerId))
      throw new Error('Local relay peer ID is invalid');
  }

  setMicrophone(track: MediaStreamTrack | null): void {
    this.microphone = track;
    for (const [peerId, peer] of this.peers) {
      peer.encoderToken = undefined;
      disposeSafely(peer.encoder);
      peer.encoder = undefined;
      if (track && peer.crypto)
        void this.startEncoder(peerId, peer).catch((error) =>
          this.failPeer(peerId, peer, error),
        );
    }
  }

  async start(peerId: string): Promise<void> {
    if (this.disposed) throw new Error('Voice relay is disposed');
    if (!validPeer(peerId) || peerId === this.options.localPeerId)
      throw new Error('Voice relay peer ID is invalid');
    if (!this.peers.has(peerId) && this.peers.size >= 8)
      throw new Error('Voice relay supports at most eight peers');
    const peer = this.peers.get(peerId) ?? this.newPeer();
    if (peer.wanted) return;
    peer.wanted = true;
    this.peers.set(peerId, peer);
    this.options.onState(peerId, 'connecting');
    this.ensureSocket();
    try {
      if (this.options.localPeerId.localeCompare(peerId) < 0)
        await this.offer(peerId, peer);
      else {
        await this.signal(peerId, { kind: 'ready' });
        this.armHandshake(peerId, peer);
      }
    } catch (error) {
      this.failPeer(peerId, peer, error);
      throw error;
    }
  }

  stop(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    void this.signal(peerId, { kind: 'stop', epoch: peer.epoch }).catch(
      () => {},
    );
    this.removePeer(peerId, 'Voice relay stopped');
  }

  async handleSignal(value: unknown): Promise<void> {
    try {
      await this.handleSignalUnsafe(value);
    } catch (error) {
      const from = (value as { from?: unknown } | null)?.from;
      if (validPeer(from)) {
        const peer = this.peers.get(from);
        if (peer) this.failPeer(from, peer, error);
      }
    }
  }

  private async handleSignalUnsafe(value: unknown): Promise<void> {
    if (this.disposed || !value || typeof value !== 'object') return;
    const signal = value as Partial<VoiceRelaySignal>;
    if (
      signal.type !== 'signal' ||
      signal.transport !== 'voice-relay' ||
      !validPeer(signal.from) ||
      signal.from === this.options.localPeerId ||
      !signal.data
    )
      return;
    const peerId = signal.from;
    const data = signal.data;
    if (!['ready', 'offer', 'answer', 'stop'].includes(data.kind)) return;
    if (data.kind === 'stop') {
      const current = this.peers.get(peerId);
      if (data.epoch && current?.epoch && data.epoch !== current.epoch) return;
      this.removePeer(peerId, 'The remote relay stopped');
      return;
    }
    let peer = this.peers.get(peerId);
    if (!peer) {
      if (this.peers.size >= 8) return;
      peer = this.newPeer();
      peer.wanted = true;
      this.peers.set(peerId, peer);
      this.options.onState(peerId, 'connecting');
      this.ensureSocket();
    }
    if (data.kind === 'ready') {
      if (this.options.localPeerId.localeCompare(peerId) < 0)
        await this.offer(peerId, peer);
      return;
    }
    if (
      (data.kind !== 'offer' && data.kind !== 'answer') ||
      typeof data.epoch !== 'string' ||
      data.epoch.length === 0 ||
      data.epoch.length > 64 ||
      typeof data.publicKey !== 'string'
    )
      return;
    if (data.kind === 'offer') {
      // The lexical initiator wins simultaneous offers, yielding one epoch.
      if (this.options.localPeerId.localeCompare(peerId) < 0) {
        if (!peer.epoch) await this.offer(peerId, peer);
        return;
      }
      if (peer.epoch === data.epoch && peer.phase !== 'idle') return;
      const generation = ++peer.generation;
      this.resetMedia(peerId, peer);
      peer.phase = 'answering';
      peer.epoch = data.epoch;
      const keyPair = await createVoiceKeyPair();
      if (!this.current(peerId, peer, generation)) return;
      peer.keyPair = keyPair;
      const session = await VoiceCryptoSession.create(
        this.options.localPeerId,
        peerId,
        data.epoch,
        keyPair,
        data.publicKey,
      );
      if (!this.current(peerId, peer, generation)) return;
      peer.crypto = session;
      await this.signal(peerId, {
        kind: 'answer',
        epoch: data.epoch,
        publicKey: keyPair.publicKey,
      });
      if (!this.current(peerId, peer, generation)) return;
      await this.activate(peerId, peer, generation);
      return;
    }
    if (
      peer.epoch !== data.epoch ||
      !peer.keyPair ||
      peer.phase !== 'offering' ||
      peer.crypto
    )
      return;
    const generation = peer.generation;
    const session = await VoiceCryptoSession.create(
      this.options.localPeerId,
      peerId,
      data.epoch,
      peer.keyPair,
      data.publicKey,
    );
    if (
      this.current(peerId, peer, generation) &&
      peer.phase === 'offering' &&
      !peer.crypto
    ) {
      peer.crypto = session;
      await this.activate(peerId, peer, generation);
    }
  }

  async getVerificationCode(peerId: string): Promise<string | null> {
    return this.peers.get(peerId)?.crypto?.getVerificationCode() ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    for (const peerId of [...this.peers.keys()])
      this.removePeer(peerId, 'Voice relay disposed');
    this.socketGeneration += 1;
    this.socket?.close();
    this.socket = null;
  }

  private newPeer(): Peer {
    return {
      wanted: false,
      generation: 0,
      exposed: false,
      encrypting: 0,
      decrypting: 0,
      bitrate: NORMAL_BITRATE,
      phase: 'idle',
      handshakeAttempts: 0,
    };
  }

  private current(peerId: string, peer: Peer, generation: number): boolean {
    return (
      !this.disposed &&
      this.peers.get(peerId) === peer &&
      peer.generation === generation &&
      peer.wanted
    );
  }

  private async offer(peerId: string, peer: Peer): Promise<void> {
    const generation = ++peer.generation;
    this.resetMedia(peerId, peer);
    peer.phase = 'offering';
    peer.epoch = epoch();
    const keyPair = await createVoiceKeyPair();
    if (!this.current(peerId, peer, generation)) return;
    peer.keyPair = keyPair;
    await this.signal(peerId, {
      kind: 'offer',
      epoch: peer.epoch,
      publicKey: keyPair.publicKey,
    });
    if (this.current(peerId, peer, generation)) this.armHandshake(peerId, peer);
  }

  private async activate(
    peerId: string,
    peer: Peer,
    generation: number,
  ): Promise<void> {
    const decoder = await createVoiceDecoder((error) =>
      this.failPeer(peerId, peer, error),
    );
    if (!this.current(peerId, peer, generation)) {
      disposeSafely(decoder);
      return;
    }
    peer.decoder = decoder;
    peer.phase = 'active';
    this.armHandshake(peerId, peer, 8_000);
    if (this.microphone) await this.startEncoder(peerId, peer);
  }

  private async startEncoder(peerId: string, peer: Peer): Promise<void> {
    const track = this.microphone;
    const generation = peer.generation;
    if (!track || peer.encoder || peer.encoderToken || !peer.crypto) return;
    const token = {};
    peer.encoderToken = token;
    let encoder: Encoder;
    try {
      encoder = await createVoiceEncoder(
        track,
        (packet) =>
          void this.sendPacket(
            peerId,
            peer,
            generation,
            packet,
            performance.now(),
          ),
        (error) => this.failPeer(peerId, peer, error),
      );
    } catch (error) {
      if (peer.encoderToken === token) peer.encoderToken = undefined;
      throw error;
    }
    if (
      !this.current(peerId, peer, generation) ||
      track !== this.microphone ||
      peer.encoderToken !== token
    ) {
      disposeSafely(encoder);
      return;
    }
    peer.encoderToken = undefined;
    peer.encoder = encoder;
    peer.encoder.setBitrate(peer.bitrate);
  }

  private async sendPacket(
    peerId: string,
    peer: Peer,
    generation: number,
    packet: Uint8Array,
    queuedAt: number,
  ): Promise<void> {
    const socket = this.socket;
    const bufferBudget = Math.min(
      MAX_BUFFERED_BYTES,
      Math.max(4 * 1024, this.peers.size * 4 * 1024),
    );
    if (
      !this.current(peerId, peer, generation) ||
      !peer.crypto ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      peer.encrypting >= MAX_CRYPTO_JOBS
    )
      return;
    if (socket.bufferedAmount > bufferBudget) {
      if (peer.bitrate !== CONGESTED_BITRATE) {
        peer.bitrate = CONGESTED_BITRATE;
        peer.encoder?.setBitrate(peer.bitrate);
      }
      return;
    }
    if (
      peer.bitrate !== NORMAL_BITRATE &&
      socket.bufferedAmount < bufferBudget / 4
    ) {
      peer.bitrate = NORMAL_BITRATE;
      peer.encoder?.setBitrate(peer.bitrate);
    }
    peer.encrypting += 1;
    try {
      const encrypted = await peer.crypto.encrypt(packet);
      if (
        !this.current(peerId, peer, generation) ||
        socket !== this.socket ||
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > bufferBudget ||
        performance.now() - queuedAt > 100
      )
        return;
      socket.send(
        JSON.stringify({
          type: 'voice',
          to: peerId,
          epoch: peer.epoch,
          sequence: encrypted.sequence,
          data: encrypted.data,
        }),
      );
    } catch (error) {
      this.failPeer(peerId, peer, error);
    } finally {
      peer.encrypting -= 1;
    }
  }

  private async receivePacket(message: Record<string, unknown>): Promise<void> {
    if (
      message.type !== 'voice' ||
      !validPeer(message.from) ||
      typeof message.epoch !== 'string' ||
      typeof message.sequence !== 'number' ||
      typeof message.data !== 'string'
    )
      return;
    const peerId = message.from;
    const peer = this.peers.get(peerId);
    if (
      !peer?.crypto ||
      !peer.decoder ||
      peer.epoch !== message.epoch ||
      peer.decrypting >= MAX_CRYPTO_JOBS
    )
      return;
    const generation = peer.generation;
    peer.decrypting += 1;
    try {
      const packet = await peer.crypto.decrypt(message.sequence, message.data);
      if (!packet || !this.current(peerId, peer, generation)) return;
      peer.decoder.push(packet, message.sequence);
      if (!peer.exposed) {
        peer.exposed = true;
        this.reconnectAttempts = 0;
        if (peer.handshakeTimer !== undefined)
          clearTimeout(peer.handshakeTimer);
        peer.handshakeTimer = undefined;
        this.options.onTrack(peerId, peer.decoder.track);
        this.options.onState(peerId, 'relayed');
      }
    } catch (error) {
      this.failPeer(peerId, peer, error);
    } finally {
      peer.decrypting -= 1;
    }
  }

  private ensureSocket(): void {
    if (this.disposed || this.socket) return;
    const generation = ++this.socketGeneration;
    const relayUrl = new URL(
      this.options.url,
      globalThis.location?.href ?? 'https://localhost',
    );
    if (relayUrl.protocol === 'http:') relayUrl.protocol = 'ws:';
    if (relayUrl.protocol === 'https:') relayUrl.protocol = 'wss:';
    if (!['ws:', 'wss:'].includes(relayUrl.protocol))
      throw new Error('Voice relay URL must use WebSocket transport');
    const socket = new WebSocket(relayUrl);
    const connectTimeout = globalThis.setTimeout(() => {
      if (
        generation === this.socketGeneration &&
        socket.readyState !== WebSocket.OPEN
      )
        socket.close();
    }, 8_000);
    this.socket = socket;
    socket.addEventListener('open', () => {
      clearTimeout(connectTimeout);
      if (this.disposed || generation !== this.socketGeneration)
        return socket.close();
      this.startHeartbeat(socket, generation);
    });
    socket.addEventListener('message', (event) => {
      if (
        generation !== this.socketGeneration ||
        typeof event.data !== 'string'
      )
        return;
      try {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type === 'ping' && typeof message.request_id === 'string') {
          socket.send(
            JSON.stringify({ type: 'pong', request_id: message.request_id }),
          );
          return;
        }
        if (
          message.type === 'pong' &&
          message.request_id === this.pendingPing
        ) {
          this.pendingPing = undefined;
          return;
        }
        void this.receivePacket(message);
      } catch {
        // Malformed relay messages are untrusted and ignored.
      }
    });
    const disconnected = () => {
      clearTimeout(connectTimeout);
      if (generation !== this.socketGeneration) return;
      if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      this.pendingPing = undefined;
      this.socket = null;
      for (const [peerId, peer] of this.peers) {
        if (!peer.wanted) continue;
        peer.generation += 1;
        this.resetMedia(peerId, peer);
        peer.handshakeAttempts = 0;
        this.options.onState(peerId, 'connecting', 'Voice relay reconnecting');
      }
      if (this.disposed || this.reconnectAttempts >= 3) {
        for (const peerId of [...this.peers.keys()])
          this.removePeer(peerId, 'Voice relay connection is unavailable');
        return;
      }
      const delay = 250 * 2 ** this.reconnectAttempts++;
      this.reconnectTimer = globalThis.setTimeout(() => {
        this.reconnectTimer = undefined;
        this.ensureSocket();
        for (const [peerId, peer] of this.peers)
          if (peer.wanted)
            void (
              this.options.localPeerId.localeCompare(peerId) < 0
                ? this.offer(peerId, peer)
                : this.signal(peerId, { kind: 'ready' }).then(() =>
                    this.armHandshake(peerId, peer),
                  )
            ).catch((error) => this.failPeer(peerId, peer, error));
      }, delay);
    };
    socket.addEventListener('close', disconnected, { once: true });
    socket.addEventListener('error', () => socket.close(), { once: true });
  }

  private startHeartbeat(socket: WebSocket, generation: number): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = globalThis.setInterval(() => {
      if (
        generation !== this.socketGeneration ||
        socket.readyState !== WebSocket.OPEN
      )
        return;
      if (this.pendingPing) {
        socket.close();
        return;
      }
      this.pendingPing = epoch();
      socket.send(
        JSON.stringify({ type: 'ping', request_id: this.pendingPing }),
      );
    }, 5_000);
  }

  private armHandshake(peerId: string, peer: Peer, delay = 3_000): void {
    if (peer.handshakeTimer !== undefined) clearTimeout(peer.handshakeTimer);
    peer.handshakeTimer = globalThis.setTimeout(() => {
      peer.handshakeTimer = undefined;
      if (this.peers.get(peerId) !== peer || !peer.wanted || peer.exposed)
        return;
      if (peer.phase === 'active' || peer.handshakeAttempts >= 2) {
        this.removePeer(
          peerId,
          'Voice relay did not receive authenticated audio',
        );
        return;
      }
      peer.handshakeAttempts += 1;
      void (
        this.options.localPeerId.localeCompare(peerId) < 0
          ? this.offer(peerId, peer)
          : this.signal(peerId, { kind: 'ready' }).then(() =>
              this.armHandshake(peerId, peer),
            )
      ).catch((error) => this.failPeer(peerId, peer, error));
    }, delay);
  }

  private resetMedia(peerId: string, peer: Peer): void {
    peer.encoderToken = undefined;
    disposeSafely(peer.encoder);
    disposeSafely(peer.decoder);
    peer.encoder = undefined;
    peer.decoder = undefined;
    peer.crypto = undefined;
    peer.keyPair = undefined;
    peer.phase = 'idle';
    if (peer.handshakeTimer !== undefined) clearTimeout(peer.handshakeTimer);
    peer.handshakeTimer = undefined;
    if (peer.exposed) {
      peer.exposed = false;
      this.options.onTrack(peerId, null);
    }
  }

  private removePeer(peerId: string, message: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.wanted = false;
    peer.generation += 1;
    this.resetMedia(peerId, peer);
    this.peers.delete(peerId);
    this.options.onState(peerId, 'unavailable', message);
    if (this.peers.size === 0) {
      if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      this.pendingPing = undefined;
      this.socketGeneration += 1;
      this.socket?.close();
      this.socket = null;
    }
  }

  private failPeer(peerId: string, peer: Peer, error: unknown): void {
    if (this.peers.get(peerId) !== peer) return;
    const message =
      error instanceof Error ? error.message : 'Voice relay failed';
    this.removePeer(peerId, message);
  }

  private async signal(
    peerId: string,
    data: VoiceRelaySignal['data'],
  ): Promise<void> {
    await this.options.sendSignal({
      type: 'signal',
      transport: 'voice-relay',
      to: peerId,
      data,
    });
  }
}
