import { screenReceiverDiagnostics, videoCapabilities } from './screenDiagnostics';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { MediaSignal, SignalingAdapter } from './types';
import { isRelayCandidate } from './utils';
import { registerNativeScreenTrack } from './nativeCaptureRegistry';
export { nativeScreenSessionForTrack } from './nativeCaptureRegistry';

export interface NativeScreenEncoder {
  id: 'h264_nvenc' | 'h264_amf' | 'h264_qsv' | 'libx264';
  label: string;
  available: boolean;
  reason: string;
}
export interface NativeScreenCapabilities {
  available: boolean;
  detail: string;
  encoders: NativeScreenEncoder[];
  version: 1;
}
export interface NativeScreenSource {
  id: string;
  kind: 'window' | 'monitor';
  name: string;
  width: number;
  height: number;
  category?: 'display' | 'game' | 'browser' | 'app' | 'utility';
  minimized?: boolean;
}
export interface NativeScreenStartOptions {
  sourceId: string;
  encoder: NativeScreenEncoder['id'];
  width: number;
  height: number;
  /** Native capture accepts whole-frame rates from 15 through 240 FPS. */
  fps: number;
  /** Per-viewer native video bitrate, from 1 through 200 Mbps. */
  bitrateMbps: number;
  /** High requires every current receiver to advertise the matching 6400 profile. */
  h264Profile?: 'auto' | NativeH264Profile;
  cursor: boolean;
  displayBorder?: boolean;
  systemAudio?: boolean;
  /** Restrict shared audio to this selected window; absent means system excluding call. */
  systemAudioSourceId?: string;
  excludeCallAudio?: boolean;
}

export type NativeH264Profile = 'baseline' | 'main' | 'high';

export function nativeH264ProfileSupported(profile: NativeH264Profile): boolean {
  if (profile === 'baseline') return true;
  const prefix = profile === 'main' ? '4d00' : '6400';
  const codecs = globalThis.RTCRtpReceiver?.getCapabilities?.('video')?.codecs ?? [];
  return codecs.some((codec) => {
    if (codec.mimeType.toLowerCase() !== 'video/h264') return false;
    const fmtp = codec.sdpFmtpLine ?? '';
    return /(?:^|;)\s*packetization-mode=1(?:;|$)/i.test(fmtp)
      && new RegExp(`(?:^|;)\\s*profile-level-id=${prefix}[0-9a-f]{2}(?:;|$)`, 'i').test(fmtp);
  });
}

export function nativeH264HighProfileSupported(): boolean {
  return nativeH264ProfileSupported('high');
}

function offeredNativeProfile(sdp?: string): NativeH264Profile {
  if (/profile-level-id=6400[0-9a-f]{2}/i.test(sdp ?? '')) return 'high';
  if (/profile-level-id=4d00[0-9a-f]{2}/i.test(sdp ?? '')) return 'main';
  return 'baseline';
}

type Session = NativeScreenStartOptions & { sessionId: string };
type Receiver = {
  captureId: string;
  pc: RTCPeerConnection;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  fallbackRequested: boolean;
};
type ProfileMessage = {
  kind: 'native-screen-profile-query' | 'native-screen-profile-reply';
  nonce: string;
  profiles?: NativeH264Profile[];
  runtime?: 'browser' | 'desktop';
};
type PendingProfileQuery = {
  peers: Set<string>;
  replies: Map<string, Set<NativeH264Profile>>;
  finish: () => void;
  timer: ReturnType<typeof setTimeout>;
};
const isRelay = (candidate: RTCIceCandidateInit) =>
  isRelayCandidate(candidate) ||
  /\styp\srelay(?:\s|$)/.test(candidate.candidate ?? '');

export class NativeScreenTransport {
  private session?: Session;
  private diagnosticEvents: { at: number; peer: number; event: string; detail?: string }[] = [];
  private diagnosticPeers = new Map<string, number>();
  private diagnosticStarted = performance.now();
  private samples: { at: number; peer: number; bytes: number; frames: number; packets: number; state: string }[] = [];
  private log(peerId: string, event: string, detail?: string) {
    if (!this.diagnosticPeers.has(peerId) && this.diagnosticPeers.size < 64) this.diagnosticPeers.set(peerId, this.diagnosticPeers.size + 1);
    this.diagnosticEvents.push({ at: Math.round(performance.now() - this.diagnosticStarted), peer: this.diagnosticPeers.get(peerId) ?? 0, event, detail });
    if (this.diagnosticEvents.length > 200) this.diagnosticEvents.shift();
  }
  noteSignalFailure(signal: MediaSignal) { this.log(signal.from ?? 'unknown', 'signal-failed', signal.type); }
  async getDiagnostics() {
    return {
      iceConfiguration: { stun: this.nativeIceServers().some(server => server.urls.some(url => /^stuns?:/i.test(url))), turn: this.nativeIceServers().some(server => server.urls.some(url => /^turns?:/i.test(url))) },
      directOnly: this.directOnly, activeProfile: this.activeProfile, sending: Boolean(this.session),
      outboundPeers: this.outboundPeers.size, capabilities: videoCapabilities(), events: [...this.diagnosticEvents], samples: [...this.samples],
      sender: this.session ? await invoke('native_screen_diagnostics', { sessionId: this.session.sessionId }).catch(() => ({ unavailable: true, requiresDesktop: '0.1.5' })) : undefined,
      receivers: await Promise.all([...this.receivers].map(async ([id, receiver]) => ({ peer: this.diagnosticPeers.get(id) ?? 0, ...await screenReceiverDiagnostics(receiver.pc).catch(() => ({ unavailable: true })) }))),
    };
  }
  private preview?: RTCPeerConnection;
  private receivers = new Map<string, Receiver>();
  private pendingReceiverCandidates = new Map<
    string,
    { captureId: string; candidates: (RTCIceCandidateInit | null)[] }
  >();
  private outboundPeers = new Set<string>();
  private generation = 0;
  private disposed = false;
  private unlisten?: UnlistenFn;
  private activeProfile: NativeH264Profile = 'baseline';
  private pendingProfileQueries = new Map<string, PendingProfileQuery>();
  private peerProfiles = new Map<string, Set<NativeH264Profile>>();
  private peerRuntimes = new Map<string, 'browser' | 'desktop'>();

  constructor(
    private signaling: SignalingAdapter,
    private iceServers: RTCIceServer[],
    private directOnly: boolean,
    private onPreview: (track: MediaStreamTrack | null) => void,
    private onRemote: (peerId: string, track: MediaStreamTrack) => void,
    private onRemoteRemoved: (peerId: string) => void,
    private onEnded: (reason: string) => void,
    private onFallbackRequested: (peerId: string) => Promise<void> = async () => undefined,
  ) {}

  get active() {
    return Boolean(this.session);
  }

  async getReceiverStats(peerId: string) {
    const receiver = this.receivers.get(peerId);
    if (!receiver) return undefined;
    const report = await receiver.pc.getStats();
    const rows = [...report.values()];
    const video = rows.find(row => row.type === 'inbound-rtp' && (row.kind ?? row.mediaType) === 'video');
    this.samples.push({ at: Math.round(performance.now() - this.diagnosticStarted), peer: this.diagnosticPeers.get(peerId) ?? 0, bytes: Number(video?.bytesReceived) || 0, frames: Number(video?.framesDecoded) || 0, packets: Number(video?.packetsReceived) || 0, state: receiver.pc.connectionState });
    if (this.samples.length > 120) this.samples.shift();
    return {
      connectionState: receiver.pc.connectionState,
      bytesReceived: Number(video?.bytesReceived) || 0,
      framesDecoded: Number(video?.framesDecoded) || 0,
      packetsLost: Number(video?.packetsLost) || 0,
      codec: rows.find(row => row.id === video?.codecId)?.mimeType as string | undefined,
    };
  }

  private nativeIceServers() {
    return this.iceServers
      .map((server) => ({
        ...server,
        urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
          (url) => !this.directOnly || !/^turns?:/.test(url),
        ),
      }))
      .filter((server) => server.urls.length > 0);
  }

  private allowedDescription(description: RTCSessionDescriptionInit) {
    if (!this.directOnly || !description.sdp) return description;
    return {
      ...description,
      sdp: description.sdp
        .split(/(?<=\r\n)/)
        .filter((line) => !/^a=candidate:.*\styp\srelay(?:\s|\r?$)/.test(line))
        .join(''),
    };
  }

  async start(options: NativeScreenStartOptions, peerIds: string[] = []): Promise<void> {
    if (this.session) await this.stop();
    const generation = ++this.generation;
    const currentPeers = [...new Set(peerIds.filter((peerId) => peerId !== this.signaling.localPeerId))];
    if (currentPeers.length > 7)
      throw new Error('Native screen sharing supports up to 7 other people');
    const requestedProfile = options.h264Profile ?? 'auto';
    // Keep direct IPC/backward-compatible starts synchronous through the invoke.
    // Negotiation is only needed when the caller supplied remote participants.
    const h264Profile = requestedProfile === 'auto'
      ? currentPeers.length > 0 ? await this.commonProfile(currentPeers) : this.bestLocalProfile()
      : requestedProfile;
    if (generation !== this.generation) return;
    if (!nativeH264ProfileSupported(h264Profile)) {
      throw new Error(`This browser cannot decode the requested H.264 ${h264Profile} profile. Use baseline compatibility mode.`);
    }
    if (requestedProfile !== 'auto' && h264Profile !== 'baseline' && currentPeers.length > 0) {
      const replies = await this.queryProfiles(currentPeers);
      if (generation !== this.generation) return;
      if (peerIds.some((peerId) => !replies.get(peerId)?.has(h264Profile))) {
        throw new Error(`Every current participant must support H.264 ${h264Profile}. Use automatic or baseline compatibility mode.`);
      }
    }
    const session = await invoke<Session>('native_screen_start', {
      ...options,
      h264Profile,
    });
    if (generation !== this.generation) {
      await invoke('native_screen_stop', {
        sessionId: session.sessionId,
      }).catch(() => undefined);
      return;
    }
    this.session = session;
    this.activeProfile = h264Profile;
    this.log('self', 'capture-started', h264Profile);
    try {
      const unlisten = await listen<{ sessionId: string; reason: string }>(
        'native-screen-ended',
        ({ payload }) => {
          if (payload.sessionId !== this.session?.sessionId) return;
          this.onEnded(payload.reason);
          void this.stop();
        },
      );
      if (generation !== this.generation) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      await this.createPreview(generation);
    } catch (error) {
      if (this.session === session) await this.stop();
      throw error;
    }
  }

  async addPeer(peerId: string): Promise<void> {
    const session = this.session;
    const generation = this.generation;
    if (
      !session ||
      peerId === this.signaling.localPeerId ||
      this.outboundPeers.has(peerId)
    )
      return;
    this.outboundPeers.add(peerId);
    this.log(peerId, 'sender-peer-start');
    if (this.outboundPeers.size > 7) {
      this.outboundPeers.delete(peerId);
      throw new Error('Native screen sharing supports up to 7 other people');
    }
    try {
      let profiles = this.peerProfiles.get(peerId);
      if (!profiles || !this.peerRuntimes.has(peerId)) {
        profiles = (await this.queryProfiles([peerId])).get(peerId);
      }
      if (this.peerRuntimes.get(peerId) === 'desktop') {
        this.log(peerId, 'desktop-viewer-compatibility');
        await this.onFallbackRequested(peerId);
        this.outboundPeers.delete(peerId);
        this.log(peerId, 'fallback-sender-active', 'desktop-viewer');
        return;
      }
      if (this.activeProfile !== 'baseline') {
        if (!profiles?.has(this.activeProfile)) {
          throw new Error(`This participant cannot decode H.264 ${this.activeProfile}. Restart the share in baseline compatibility mode.`);
        }
      }
      if (session !== this.session || generation !== this.generation) return;
      const description = await invoke<RTCSessionDescriptionInit>(
        'native_screen_peer_offer',
        {
          sessionId: session.sessionId,
          peerId,
          iceServers: this.nativeIceServers(),
          directOnly: this.directOnly,
        },
      );
      if (session !== this.session || generation !== this.generation) return;
      await this.signaling.send({
        type: 'offer',
        to: peerId,
        description,
        transport: 'native-screen',
        captureId: session.sessionId,
      });
    } catch (error) {
      if (session === this.session && generation === this.generation)
        this.outboundPeers.delete(peerId);
      this.log(peerId, 'sender-peer-failed', error instanceof DOMException ? error.name : 'Error');
      throw error;
    }
  }

  async removePeer(peerId: string): Promise<void> {
    this.closeReceiver(peerId);
    this.pendingReceiverCandidates.delete(peerId);
    if (this.session)
      await invoke('native_screen_peer_remove', {
        sessionId: this.session.sessionId,
        peerId,
      }).catch(() => undefined);
    this.outboundPeers.delete(peerId);
    this.peerProfiles.delete(peerId);
    this.peerRuntimes.delete(peerId);
  }

  async handle(signal: MediaSignal): Promise<boolean> {
    if (this.disposed) return false;
    if (!('transport' in signal) || signal.transport !== 'native-screen')
      return false;
    const peerId = signal.from;
    if (!peerId) throw new Error('Native screen signal requires a sender');
    if (signal.type !== 'ice-candidate') this.log(peerId, 'signal-' + signal.type);
    if (signal.type === 'signal') {
      const data = signal.data as unknown as Partial<ProfileMessage> | null;
      const validNonce = typeof data?.nonce === 'string' && data.nonce.length > 0 && data.nonce.length <= 128;
      if (data?.kind === 'native-screen-profile-query' && validNonce && signal.captureId === data.nonce) {
        const profiles: NativeH264Profile[] = ['baseline'];
        if (nativeH264ProfileSupported('main')) profiles.push('main');
        if (nativeH264ProfileSupported('high')) profiles.push('high');
        await this.signaling.send({
          type: 'signal', to: peerId, transport: 'native-screen',
          captureId: signal.captureId,
          data: {
            kind: 'native-screen-profile-reply',
            nonce: data.nonce,
            profiles,
            runtime: isTauri() ? 'desktop' : 'browser',
          },
        } as unknown as MediaSignal);
        return true;
      }
      if (data?.kind === 'native-screen-profile-reply' && validNonce) {
        const pending = this.pendingProfileQueries.get(data.nonce!);
        if (pending?.peers.has(peerId) && signal.captureId === data.nonce) {
          const advertised = Array.isArray(data.profiles) ? data.profiles : [];
          const profiles = new Set(advertised.filter((profile): profile is NativeH264Profile => ['baseline', 'main', 'high'].includes(profile)));
          pending.replies.set(peerId, profiles);
          this.peerProfiles.set(peerId, profiles);
          if (data.runtime === 'browser' || data.runtime === 'desktop')
            this.peerRuntimes.set(peerId, data.runtime);
          if (pending.replies.size === pending.peers.size) pending.finish();
        }
        return true;
      }
      if ((signal.data as { kind?: string }).kind === 'native-screen-stop')
        this.closeReceiver(peerId, signal.captureId);
      if ((signal.data as { kind?: string }).kind === 'native-screen-fallback-request') {
        const session = this.session;
        if (session?.sessionId !== signal.captureId) return true;
        this.log(peerId, 'fallback-request-received');
        await this.onFallbackRequested(peerId);
        await this.removeOutboundPeer(peerId);
        this.log(peerId, 'fallback-sender-active');
      }
      return true;
    }
    if (signal.type === 'answer') {
      this.log(peerId, 'answer-video', /^m=video 0 /m.test(signal.description.sdp ?? '') ? 'rejected' : 'accepted');
      const session = this.session;
      if (session && session.sessionId === signal.captureId)
        await invoke('native_screen_peer_answer', {
          sessionId: session!.sessionId,
          peerId,
          description: signal.description,
        });
      return true;
    }
    if (signal.type === 'ice-candidate') {
      if (signal.candidate && this.directOnly && isRelay(signal.candidate))
        return true;
      const session = this.session;
      if (session && session.sessionId === signal.captureId)
        await invoke('native_screen_peer_candidate', {
          sessionId: session.sessionId,
          peerId,
          candidate: signal.candidate,
        });
      else {
        const receiver = this.receivers.get(peerId);
        if (
          receiver &&
          receiver.captureId === signal.captureId &&
          receiver.pc.remoteDescription
        )
          await receiver.pc.addIceCandidate(signal.candidate);
        else {
          const pending = this.pendingReceiverCandidates.get(peerId);
          if (pending && pending.captureId === signal.captureId) {
            if (pending.candidates.length >= 256)
              throw new Error('Too many queued native screen ICE candidates');
            pending.candidates.push(signal.candidate);
          } else {
            if (!pending && this.pendingReceiverCandidates.size >= 16)
              throw new Error('Too many pending native screen receivers');
            this.pendingReceiverCandidates.set(peerId, {
              captureId: signal.captureId!,
              candidates: [signal.candidate],
            });
          }
        }
      }
      return true;
    }
    if (signal.type === 'offer') {
      const offeredProfile = offeredNativeProfile(signal.description.sdp);
      this.log(peerId, 'offered-profile', offeredProfile);
      if (!nativeH264ProfileSupported(offeredProfile)) {
        throw new Error(`This native screen share requires H.264 ${offeredProfile} profile. Ask the sender to restart in baseline compatibility mode.`);
      }
      this.closeReceiver(peerId);
      if (this.receivers.size >= 16)
        throw new Error('Too many native screen receivers');
      const pc = this.makeReceiver(peerId, signal.captureId!);
      this.receivers.set(peerId, {
        pc,
        captureId: signal.captureId!,
        fallbackRequested: false,
      });
      await pc.setRemoteDescription(
        this.allowedDescription(signal.description),
      );
      if (this.disposed || this.receivers.get(peerId)?.pc !== pc) { pc.close(); return true; }
      const pending = this.pendingReceiverCandidates.get(peerId);
      if (pending && pending.captureId === signal.captureId) {
        this.pendingReceiverCandidates.delete(peerId);
        for (const candidate of pending.candidates)
          await pc.addIceCandidate(candidate);
      }
      await pc.setLocalDescription(await pc.createAnswer());
      this.log(peerId, 'receiver-answer-video', /^m=video 0 /m.test(pc.localDescription?.sdp ?? '') ? 'rejected' : 'accepted');
      if (this.disposed || this.receivers.get(peerId)?.pc !== pc) { pc.close(); return true; }
      await this.signaling.send({
        type: 'answer',
        to: peerId,
        description: pc.localDescription!.toJSON(),
        transport: 'native-screen',
        captureId: signal.captureId,
      });
      const receiver = this.receivers.get(peerId);
      if (receiver?.pc === pc) {
        receiver.fallbackTimer = globalThis.setTimeout(() => {
          void this.requestReceiverFallback(peerId, signal.captureId!, 'no-media-timeout');
        }, 5_000);
      }
      return true;
    }
    return true;
  }

  async stop(): Promise<void> {
    ++this.generation;
    this.finishProfileQueries();
    const session = this.session;
    this.session = undefined;
    this.activeProfile = 'baseline';
    this.peerProfiles.clear();
    this.peerRuntimes.clear();
    this.unlisten?.();
    this.unlisten = undefined;
    this.preview?.close();
    this.preview = undefined;
    this.onPreview(null);
    if (!session) return;
    const peers = [...this.outboundPeers];
    this.outboundPeers.clear();
    await Promise.allSettled([
      ...peers.map((peerId) =>
        this.signaling.send({
          type: 'signal',
          to: peerId,
          transport: 'native-screen',
          captureId: session.sessionId,
          data: { kind: 'native-screen-stop', captureId: session.sessionId },
        }),
      ),
      invoke('native_screen_stop', { sessionId: session.sessionId }),
    ]);
  }

  dispose() {
    this.disposed = true;
    void this.stop();
    for (const peerId of [...this.receivers.keys()]) this.closeReceiver(peerId);
    this.pendingReceiverCandidates.clear();
    this.finishProfileQueries();
  }

  private async commonProfile(peerIds: string[]): Promise<NativeH264Profile> {
    const peers = [...new Set(peerIds.filter((peerId) => peerId !== this.signaling.localPeerId))];
    if (peers.length > 7) throw new Error('Native screen sharing supports up to 7 other people');
    if (peers.length === 0) return this.bestLocalProfile();
    const replies = await this.queryProfiles(peers);
    if (replies.size !== peers.length) return 'baseline';
    for (const profile of ['high', 'main'] as const) {
      if (nativeH264ProfileSupported(profile) && peers.every((peerId) => replies.get(peerId)?.has(profile))) return profile;
    }
    return 'baseline';
  }

  private bestLocalProfile(): NativeH264Profile {
    if (nativeH264ProfileSupported('high')) return 'high';
    if (nativeH264ProfileSupported('main')) return 'main';
    return 'baseline';
  }

  private queryProfiles(peerIds: string[]): Promise<Map<string, Set<NativeH264Profile>>> {
    if (peerIds.length > 7)
      return Promise.reject(new Error('Native screen sharing supports up to 7 other people'));
    const peers = new Set(peerIds);
    if (peers.size === 0) return Promise.resolve(new Map());
    const nonce = crypto.randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      const replies = new Map<string, Set<NativeH264Profile>>();
      const finish = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        this.pendingProfileQueries.delete(nonce);
        resolve(replies);
      };
      const timer = globalThis.setTimeout(finish, 1_000);
      this.pendingProfileQueries.set(nonce, { peers, replies, finish, timer });
      for (const peerId of peers) {
        void Promise.resolve(this.signaling.send({
          type: 'signal', to: peerId, transport: 'native-screen', captureId: nonce,
          data: { kind: 'native-screen-profile-query', nonce },
        } as unknown as MediaSignal)).catch(() => undefined);
      }
    });
  }

  private finishProfileQueries() {
    for (const pending of [...this.pendingProfileQueries.values()]) pending.finish();
    this.pendingProfileQueries.clear();
  }

  private makeReceiver(peerId: string, captureId: string) {
    const pc = new RTCPeerConnection({ iceServers: this.nativeIceServers() });
    pc.ontrack = ({ track }) => {
      this.log(peerId, 'track-received', track.kind);
      track.addEventListener('unmute', () => this.log(peerId, 'track-unmuted'), { once: true });
      this.onRemote(peerId, track);
      track.addEventListener(
        'ended',
        () => this.closeReceiver(peerId, captureId),
        { once: true },
      );
    };
    pc.onconnectionstatechange = () => {
      this.log(peerId, 'connection', pc.connectionState);
      if (pc.connectionState === 'failed') {
        void this.requestReceiverFallback(peerId, captureId, 'connection-failed')
          .finally(() => this.closeReceiver(peerId, captureId));
      }
    };
    pc.oniceconnectionstatechange = () => this.log(peerId, 'ice', pc.iceConnectionState);
    pc.onsignalingstatechange = () => this.log(peerId, 'signaling', pc.signalingState);
    pc.onicecandidateerror = event => this.log(peerId, 'ice-server-error', String(event.errorCode));
    pc.onicecandidate = ({ candidate }) => {
      const serialized = candidate?.toJSON() ?? null;
      if (serialized && this.directOnly && isRelay(serialized)) return;
      void Promise.resolve(
        this.signaling.send({
          type: 'ice-candidate',
          to: peerId,
          candidate: serialized,
          transport: 'native-screen',
          captureId,
        }),
      ).catch(() => undefined);
    };
    return pc;
  }

  private closeReceiver(peerId: string, captureId?: string) {
    const receiver = this.receivers.get(peerId);
    if (!receiver || (captureId && receiver.captureId !== captureId)) return;
    this.log(peerId, 'receiver-closed', receiver.pc.connectionState);
    globalThis.clearTimeout(receiver.fallbackTimer);
    receiver.pc.close();
    this.receivers.delete(peerId);
    this.pendingReceiverCandidates.delete(peerId);
    this.onRemoteRemoved(peerId);
  }

  /** The ordinary call connection now owns this peer's screen track. */
  finishReceiverFallback(peerId: string) {
    const receiver = this.receivers.get(peerId);
    if (!receiver?.fallbackRequested) return;
    this.log(peerId, 'fallback-receiver-active');
    globalThis.clearTimeout(receiver.fallbackTimer);
    receiver.pc.close();
    this.receivers.delete(peerId);
    this.pendingReceiverCandidates.delete(peerId);
  }

  private async requestReceiverFallback(peerId: string, captureId: string, reason: string) {
    const receiver = this.receivers.get(peerId);
    if (!receiver || receiver.captureId !== captureId || receiver.fallbackRequested) return;
    if (reason === 'no-media-timeout') {
      const report = await receiver.pc.getStats().catch(() => undefined);
      if (!report || this.receivers.get(peerId) !== receiver) return;
      const video = [...report.values()].find(row =>
        row.type === 'inbound-rtp' && (row.kind ?? row.mediaType) === 'video');
      if ((Number(video?.bytesReceived) || 0) > 0 || (Number(video?.framesDecoded) || 0) > 0)
        return;
    }
    receiver.fallbackRequested = true;
    globalThis.clearTimeout(receiver.fallbackTimer);
    this.log(peerId, 'fallback-requested', reason);
    await this.signaling.send({
      type: 'signal',
      to: peerId,
      transport: 'native-screen',
      captureId,
      data: { kind: 'native-screen-fallback-request', captureId },
    });
  }

  private async removeOutboundPeer(peerId: string) {
    const session = this.session;
    if (!session || !this.outboundPeers.has(peerId)) return;
    await invoke('native_screen_peer_remove', {
      sessionId: session.sessionId,
      peerId,
    }).catch(() => undefined);
    this.outboundPeers.delete(peerId);
  }

  private async createPreview(generation: number) {
    const session = this.session!;
    const offer = await invoke<RTCSessionDescriptionInit>(
      'native_screen_peer_offer',
      {
        sessionId: session.sessionId,
        peerId: '__preview',
        iceServers: [],
        directOnly: true,
      },
    );
    if (generation !== this.generation) return;
    const pc = new RTCPeerConnection();
    this.preview = pc;
    pc.ontrack = ({ track }) => {
      if (generation === this.generation && session === this.session) {
        registerNativeScreenTrack(track, session.sessionId);
        this.onPreview(track);
      } else track.stop();
    };
    pc.onicecandidate = ({ candidate }) =>
      void invoke('native_screen_peer_candidate', {
        sessionId: session.sessionId,
        peerId: '__preview',
        candidate: candidate?.toJSON() ?? null,
      }).catch(() => undefined);
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    await invoke('native_screen_peer_answer', {
      sessionId: session.sessionId,
      peerId: '__preview',
      description: pc.localDescription!.toJSON(),
    });
  }
}
