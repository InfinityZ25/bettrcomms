import { invoke } from '@tauri-apps/api/core';
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
  fps: 30 | 60;
  bitrateMbps: 8 | 10 | 12 | 16 | 20 | 40 | 80;
  /** High requires every current receiver to advertise the matching 6400 profile. */
  h264Profile?: 'auto' | NativeH264Profile;
  cursor: boolean;
  displayBorder?: boolean;
  systemAudio?: boolean;
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
type Receiver = { captureId: string; pc: RTCPeerConnection };
type ProfileMessage = {
  kind: 'native-screen-profile-query' | 'native-screen-profile-reply';
  nonce: string;
  profiles?: NativeH264Profile[];
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

  constructor(
    private signaling: SignalingAdapter,
    private iceServers: RTCIceServer[],
    private directOnly: boolean,
    private onPreview: (track: MediaStreamTrack | null) => void,
    private onRemote: (peerId: string, track: MediaStreamTrack) => void,
    private onRemoteRemoved: (peerId: string) => void,
    private onEnded: (reason: string) => void,
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
    if (this.outboundPeers.size > 7) {
      this.outboundPeers.delete(peerId);
      throw new Error('Native screen sharing supports up to 7 other people');
    }
    try {
      if (this.activeProfile !== 'baseline') {
        const profiles = this.peerProfiles.get(peerId) ?? (await this.queryProfiles([peerId])).get(peerId);
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
  }

  async handle(signal: MediaSignal): Promise<boolean> {
    if (this.disposed) return false;
    if (!('transport' in signal) || signal.transport !== 'native-screen')
      return false;
    const peerId = signal.from;
    if (!peerId) throw new Error('Native screen signal requires a sender');
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
          data: { kind: 'native-screen-profile-reply', nonce: data.nonce, profiles },
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
          if (pending.replies.size === pending.peers.size) pending.finish();
        }
        return true;
      }
      if ((signal.data as { kind?: string }).kind === 'native-screen-stop')
        this.closeReceiver(peerId, signal.captureId);
      return true;
    }
    if (signal.type === 'answer') {
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
      if (!nativeH264ProfileSupported(offeredProfile)) {
        throw new Error(`This native screen share requires H.264 ${offeredProfile} profile. Ask the sender to restart in baseline compatibility mode.`);
      }
      this.closeReceiver(peerId);
      if (this.receivers.size >= 16)
        throw new Error('Too many native screen receivers');
      const pc = this.makeReceiver(peerId, signal.captureId!);
      this.receivers.set(peerId, { pc, captureId: signal.captureId! });
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
      if (this.disposed || this.receivers.get(peerId)?.pc !== pc) { pc.close(); return true; }
      await this.signaling.send({
        type: 'answer',
        to: peerId,
        description: pc.localDescription!.toJSON(),
        transport: 'native-screen',
        captureId: signal.captureId,
      });
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
      this.onRemote(peerId, track);
      track.addEventListener(
        'ended',
        () => this.closeReceiver(peerId, captureId),
        { once: true },
      );
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed')
        this.closeReceiver(peerId, captureId);
    };
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
    receiver.pc.close();
    this.receivers.delete(peerId);
    this.pendingReceiverCandidates.delete(peerId);
    this.onRemoteRemoved(peerId);
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
