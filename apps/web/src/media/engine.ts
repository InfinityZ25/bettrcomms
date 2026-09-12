import { AudioLeveler, type AudioLevelerOptions } from './audio';
import { VisualCopilot } from './visualCopilot';
import { VoiceRelay } from './voiceRelay';
import { TrackRecordingSession, type RecordableTrack } from './recording';
import type {
  CaptureOptions,
  IceOptions,
  MediaEngineEventMap,
  MediaSignal,
  MediaQualityOptions,
  MediaSourceKind,
  RemoteTrack,
  ScreenCaptureOptions,
  PeerMediaStats,
  SignalingAdapter,
  TrackDescriptor,
} from './types';
import { findTrackDescriptor, isRelayCandidate } from './utils';
import { createDenoiser } from './denoise';
import { createSpeexDenoiser } from './speexDenoise';
import { createNvidiaDenoiser } from './nvidiaDenoise';
import { createDeepfilterDenoiser } from './deepfilterDenoise';
import { createDeepfilterWasmDenoiser } from './deepfilterWasmDenoise';
import { createMicrophoneEffects } from './microphoneEffects';
import { isTauri } from '@tauri-apps/api/core';
import { createNativeSystemAudio, type NativeSystemAudioTrack } from './nativeSystemAudio';
import type { DenoisedTrack } from './denoise';
import type { MicrophoneProcessingSettings } from './types';
import {
  NativeScreenTransport,
  type NativeScreenStartOptions,
} from './nativeScreen';

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  senders: Map<MediaSourceKind, RTCRtpSender>;
  streams: Map<MediaSourceKind, MediaStream>;
  metadata: Map<string, TrackDescriptor>;
  remote: Map<MediaSourceKind, RemoteTrack>;
  pendingTracks: Map<string, { track: MediaStreamTrack; streamIds: string[] }>;
  pendingCandidates: (RTCIceCandidateInit | null)[];
}

export interface MediaEngineOptions {
  signaling: SignalingAdapter;
  ice?: IceOptions;
  quality?: MediaQualityOptions;
  voiceRelay?: { url: string; mode?: 'automatic' | 'relay' };
}

export class MediaEngine extends EventTarget {
  readonly copilot = new VisualCopilot();
  private readonly signaling: SignalingAdapter;
  private readonly ice: Required<Pick<IceOptions, 'mode'>> & IceOptions;
  private readonly peers = new Map<string, Peer>();
  private readonly localTracks = new Map<MediaSourceKind, MediaStreamTrack>();
  private readonly trackCleanup = new Map<MediaSourceKind, () => void>();
  private quality: MediaQualityOptions;
  private readonly previousStats = new Map<
    string,
    { timestamp: number; bytes: number }
  >();
  private disposed = false;
  private microphoneInput?: MediaStreamTrack;
  private microphoneEnabled?: boolean;
  private readonly pendingMicrophones = new Set<MediaStreamTrack>();
  private readonly nativeRemote = new Map<string, RemoteTrack>();
  private readonly signalQueues = new Map<string, Promise<void>>();
  private readonly nativeScreen: NativeScreenTransport;
  private nativeAudio?: NativeSystemAudioTrack;
  private nativeAudioAbort?: AbortController;
  private nativeShareGeneration = 0;
  private readonly voiceRelay?: VoiceRelay;
  private readonly relayMode: 'automatic' | 'relay';
  private readonly relayTracks = new Map<string, RemoteTrack>();
  private readonly relayStates = new Map<string, NonNullable<PeerMediaStats['voiceRelay']>>();
  private readonly relayTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stableTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly directReady = new Set<string>();
  private readonly directProbe = new Map<string, string>();

  constructor(options: MediaEngineOptions) {
    super();
    this.signaling = options.signaling;
    this.ice = {
      mode: options.ice?.mode ?? 'direct-preferred',
      ...options.ice,
    };
    this.quality = { maxAudioBitrate: 256_000, ...options.quality };
    this.relayMode = options.voiceRelay?.mode ?? 'automatic';
    if (options.voiceRelay && this.ice.mode !== 'direct-only') {
      this.voiceRelay = new VoiceRelay({
        localPeerId: this.signaling.localPeerId,
        url: options.voiceRelay.url,
        sendSignal: (signal) => this.send(signal),
        onTrack: (peerId, track) => {
          if (track && this.peers.has(peerId) && !this.disposed) {
            const remote = { peerId, source: 'microphone' as const, track, stream: new MediaStream([track]) };
            this.relayTracks.set(peerId, remote);
            this.emit('remote-track', remote);
          } else if (this.relayTracks.delete(peerId)) {
            const direct = this.peers.get(peerId)?.remote.get('microphone');
            if (direct && !this.disposed) this.emit('remote-track', direct);
            else this.emit('remote-track-removed', { peerId, source: 'microphone' });
          }
        },
        onState: (peerId, state, message) => {
          if (this.peers.has(peerId) && !this.disposed) {
            if (state === 'unavailable' && this.directReady.has(peerId)) this.relayStates.delete(peerId);
            else this.relayStates.set(peerId, { state, message });
          }
        },
      });
    }
    this.nativeScreen = new NativeScreenTransport(
      this.signaling,
      this.ice.iceServers ?? [],
      this.ice.mode === 'direct-only',
      (track) => this.setNativePreview(track),
      (peerId, track) => {
        const remote = { peerId, source: 'screen' as const, track, stream: new MediaStream([track]) };
        this.nativeRemote.set(peerId, remote);
        this.emit('remote-track', remote);
      },
      (peerId) => {
        if (!this.nativeRemote.delete(peerId)) return;
        this.emit('remote-track-removed', { peerId, source: 'screen' });
      },
      (reason) => this.emit('error', { operation: 'native-screen-ended', error: new Error(reason) }),
      (peerId) => this.enableNativeScreenFallback(peerId),
    );
  }

  addEventListener<K extends keyof MediaEngineEventMap>(
    type: K,
    listener: (this: MediaEngine, event: MediaEngineEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
  }

  async captureUserMedia(options: CaptureOptions = {}): Promise<void> {
    this.ensureActive();
    const requestedDenoiser = options.denoiser ?? 'standard';
    const denoiser =
      (requestedDenoiser === 'nvidia' || requestedDenoiser === 'deepfilter') &&
      !isTauri()
        ? 'standard'
        : requestedDenoiser;
    const processing: MicrophoneProcessingSettings = options.processing ?? {
      engine: denoiser,
      echoCancellation: options.echoCancellation ?? true,
      autoGainControl: options.autoGainControl ?? false,
      nvidiaIntensity: 1,
      nvidiaVad: false,
      deepfilterAttenuationDb: 100,
      highPassHz: 0,
      gainDb: 0,
      gateEnabled: false,
      gateThresholdDb: -45,
      gateAttackMs: 5,
      gateHoldMs: 150,
      gateReleaseMs: 120,
    };
    const audio =
      options.microphone === false
        ? false
        : {
            ...(typeof options.microphone === 'object'
              ? options.microphone
              : {}),
            channelCount:
              typeof options.microphone === 'object' &&
              options.microphone.channelCount !== undefined
                ? options.microphone.channelCount
                : { ideal: 1 },
            noiseSuppression:
              denoiser === 'rnnoise' ||
              denoiser === 'speex' ||
              denoiser === 'deepfilter-wasm' ||
              denoiser === 'nvidia' ||
              denoiser === 'deepfilter' ||
              denoiser === 'off'
                ? false
                : (options.noiseSuppression ?? true),
            echoCancellation:
              options.echoCancellation ?? processing.echoCancellation,
            autoGainControl:
              options.autoGainControl ?? processing.autoGainControl,
          };
    const stream = await navigator.mediaDevices.getUserMedia({
      video: options.camera === undefined ? true : options.camera,
      audio,
    });
    try {
      if (this.disposed) throw new Error('MediaEngine has been disposed');
      const video = stream.getVideoTracks()[0];
      const microphone = stream.getAudioTracks()[0];
      if (video) await this.replaceLocalTrack('camera', video);
      if (
        microphone &&
        (denoiser === 'rnnoise' ||
          denoiser === 'speex' ||
          denoiser === 'deepfilter-wasm' ||
          denoiser === 'nvidia' ||
          denoiser === 'deepfilter')
      ) {
        let denoised: DenoisedTrack;
        let effects: DenoisedTrack | undefined;
        let rawOwnershipTransferred = false;
        if (
          denoiser === 'nvidia' ||
          denoiser === 'deepfilter' ||
          denoiser === 'deepfilter-wasm'
        ) {
          try {
            denoised =
              denoiser === 'nvidia'
                ? await createNvidiaDenoiser(microphone, undefined, {
                    intensity: processing.nvidiaIntensity,
                    vad: processing.nvidiaVad,
                  })
                : denoiser === 'deepfilter'
                  ? await createDeepfilterDenoiser(
                      microphone,
                      undefined,
                      processing.deepfilterAttenuationDb,
                    )
                  : await createDeepfilterWasmDenoiser(
                      microphone,
                      processing.deepfilterAttenuationDb,
                    );
          } catch (error) {
            denoised = await createDenoiser(microphone);
            const reason =
              error instanceof Error ? error.message : String(error);
            this.emit('denoiser-status', {
              requested: denoiser,
              active: 'rnnoise',
              message: `${denoiser === 'nvidia' ? 'NVIDIA' : 'DeepFilterNet3'} noise removal was unavailable (${reason}). RNNoise is active.`,
            });
          }
        } else if (denoiser === 'speex') {
          denoised = await createSpeexDenoiser(microphone);
        } else {
          denoised = await createDenoiser(microphone);
        }
        try {
          const createdEffects = await createMicrophoneEffects(
            denoised.track,
            processing,
          );
          effects = createdEffects;
          if (this.disposed) throw new Error('MediaEngine has been disposed');
          await this.replaceLocalTrack(
            'microphone',
            createdEffects.track,
            () => {
              createdEffects.dispose();
              denoised.dispose();
              if (!rawOwnershipTransferred) microphone.stop();
            },
          );
        } catch (error) {
          effects?.dispose();
          denoised.dispose();
          microphone.stop();
          throw error;
        }
        const activeEffects = effects;
        if (denoiser === 'speex' && denoised.failure) {
          void denoised.failure.then(async (error) => {
            if (
              this.disposed ||
              this.localTracks.get('microphone') !== activeEffects.track
            )
              return;
            try {
              await this.setLocalTrack('microphone', null);
            } catch (removeError) {
              this.emit('error', {
                operation: 'speex-denoiser-cleanup',
                error: removeError,
              });
            }
            this.emit('error', {
              operation: 'speex-denoiser',
              error,
            });
          });
        }
        if (
          (denoiser === 'nvidia' ||
            denoiser === 'deepfilter' ||
            denoiser === 'deepfilter-wasm') &&
          denoised.failure
        ) {
          void denoised.failure.then(async (error) => {
            if (
              this.disposed ||
              this.localTracks.get('microphone') !== activeEffects.track
            )
              return;
            const wasEnabled = activeEffects.track.enabled;
            try {
              const fallback = await createDenoiser(microphone);
              let fallbackEffects: DenoisedTrack;
              try {
                fallbackEffects = await createMicrophoneEffects(
                  fallback.track,
                  processing,
                );
              } catch (effectError) {
                fallback.dispose();
                throw effectError;
              }
              if (
                this.disposed ||
                this.localTracks.get('microphone') !== activeEffects.track
              ) {
                fallbackEffects.dispose();
                fallback.dispose();
                return;
              }
              fallbackEffects.track.enabled = wasEnabled;
              rawOwnershipTransferred = true;
              await this.replaceLocalTrack(
                'microphone',
                fallbackEffects.track,
                () => {
                  fallbackEffects.dispose();
                  fallback.dispose();
                  microphone.stop();
                },
              );
              const reason =
                error instanceof Error ? error.message : String(error);
              this.emit('denoiser-status', {
                requested: denoiser,
                active: 'rnnoise',
                message: `${denoiser === 'nvidia' ? 'NVIDIA' : 'DeepFilterNet3'} noise removal stopped (${reason}). RNNoise is active.`,
              });
            } catch (fallbackError) {
              microphone.stop();
              this.emit('error', {
                operation: `${denoiser}-denoiser-fallback`,
                error: fallbackError,
              });
            }
          });
        }
      } else if (microphone) {
        const effects = await createMicrophoneEffects(microphone, processing);
        try {
          if (this.disposed) throw new Error('MediaEngine has been disposed');
          await this.replaceLocalTrack('microphone', effects.track, () => {
            effects.dispose();
            microphone.stop();
          });
        } catch (error) {
          effects.dispose();
          microphone.stop();
          throw error;
        }
      }
      if (microphone) this.microphoneInput = microphone;
    } catch (error) {
      for (const track of stream.getTracks()) {
        if (![...this.localTracks.values()].includes(track)) track.stop();
      }
      throw error;
    }
  }

  async captureScreen(
    options: ScreenCaptureOptions = {},
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    this.ensureActive();
    const captureOptions: DisplayMediaStreamOptions & { windowAudio: 'window' | 'exclude' } = {
      // Follow the configured stream quality rather than a fixed ceiling, so a
      // high-refresh display is not silently halved before encoding starts.
      video: options.video ?? {
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        ...(this.quality.maxFramerate
          ? {
              frameRate: {
                ideal: this.quality.maxFramerate,
                max: this.quality.maxFramerate,
              },
            }
          : {}),
      },
      audio: options.systemAudio ?? true,
      // Ask supporting browsers to scope window audio to the selected application.
      // This is a picker hint; the browser/OS still controls available audio sources.
      windowAudio: options.systemAudio === false ? 'exclude' : 'window',
    };
    const stream = await navigator.mediaDevices.getDisplayMedia(captureOptions);
    // A desktop setup screen can be canceled while the OS chooser is pending.
    // Reject its late result before replacing any newer share's tracks.
    if (!isCurrent()) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException('Screen sharing was canceled', 'AbortError');
    }
    try {
      const screen = stream.getVideoTracks()[0];
      const system = stream.getAudioTracks()[0];
      // Without an explicit hint Chromium treats a screen like camera video and
      // will trade resolution away first. Unreadable text is worse than a lower
      // frame rate, so state the intent for every browser share, not only the
      // native compatibility path.
      if (screen) screen.contentHint = options.contentHint ?? 'detail';
      const endShare = () => {
        void Promise.all([
          this.setLocalTrack('screen', null),
          this.setLocalTrack('system', null),
        ]).catch((error) =>
          this.emit('error', { operation: 'end-screen-share', error }),
        );
      };
      screen?.addEventListener('ended', endShare, { once: true });
      system?.addEventListener('ended', endShare, { once: true });
      if (screen) await this.replaceLocalTrack('screen', screen);
      if (system) await this.replaceLocalTrack('system', system);
    } catch (error) {
      for (const track of stream.getTracks()) {
        if (![...this.localTracks.values()].includes(track)) track.stop();
      }
      throw error;
    }
  }

  async captureNativeScreen(options: NativeScreenStartOptions): Promise<void> {
    this.ensureActive();
    await this.stopNativeScreen();
    const generation = ++this.nativeShareGeneration;
    const abort = this.nativeAudioAbort = new AbortController();
    try {
      await this.nativeScreen.start(options, [...this.peers.keys()]);
      if (generation !== this.nativeShareGeneration || this.disposed || !this.nativeScreen.active) return;
      if (options.systemAudio) {
        const audio = await createNativeSystemAudio(abort.signal, undefined, options.systemAudioSourceId, options.excludeCallAudio);
        if (generation !== this.nativeShareGeneration || this.disposed) { audio.dispose(); return; }
        this.nativeAudio = audio;
        await this.replaceLocalTrack('system', audio.track, audio.dispose);
        if (generation !== this.nativeShareGeneration || this.disposed) {
          audio.dispose();
          if (!this.disposed && this.localTracks.get('system') === audio.track)
            await this.replaceLocalTrack('system', null);
          return;
        }
        void audio.failure.then(error => {
          if (this.nativeAudio !== audio || this.disposed) return;
          this.emit('error', { operation: 'native-system-audio', error });
          void this.stopNativeScreen();
        });
      }
      await Promise.all([...this.peers.keys()].map((id) => this.nativeScreen.addPeer(id)));
    } catch (error) {
      if (generation === this.nativeShareGeneration) await this.stopNativeScreen();
      throw error;
    }
  }

  async stopNativeScreen(): Promise<void> {
    ++this.nativeShareGeneration;
    await Promise.all([this.stopNativeSystemAudio(), this.nativeScreen.stop()]);
  }

  private async stopNativeSystemAudio(): Promise<void> {
    this.nativeAudioAbort?.abort();
    this.nativeAudioAbort = undefined;
    const audio = this.nativeAudio;
    this.nativeAudio = undefined;
    if (!audio) return;
    audio.dispose();
    if (!this.disposed && this.localTracks.get('system') === audio.track)
      await this.replaceLocalTrack('system', null);
  }

  isNativeScreenActive(): boolean {
    return this.nativeScreen.active;
  }

  async setLocalTrack(
    source: MediaSourceKind,
    track: MediaStreamTrack | null,
  ): Promise<void> {
    return this.replaceLocalTrack(source, track);
  }

  private async replaceLocalTrack(
    source: MediaSourceKind,
    track: MediaStreamTrack | null,
    cleanup?: () => void,
  ): Promise<void> {
    this.ensureActive();
    const previous = this.localTracks.get(source);
    const previousCleanup = this.trackCleanup.get(source);
    if (previous === track) return;
    if (track) this.assertSourceKind(source, track);
    // Device/denoiser replacement must never briefly publish an unmuted mic.
    if (source === 'microphone' && track) {
      track.enabled = this.microphoneEnabled ?? previous?.enabled ?? track.enabled;
      this.pendingMicrophones.add(track);
    }
    try {
      await Promise.all(
        [...this.peers.values()].map(async (peer) => {
          const sender = peer.senders.get(source);
          if (sender) {
            await sender.replaceTrack(track);
            if (!track) {
              peer.pc.removeTrack(sender);
              peer.senders.delete(source);
              peer.streams.delete(source);
            }
          } else if (track) {
            const stream = new MediaStream([track]);
            peer.streams.set(source, stream);
            const added = peer.pc.addTrack(track, stream);
            peer.senders.set(source, added);
            await this.applyQuality(added);
          }
        }),
      );
      this.ensureActive();
    } catch (error) {
      if (track) this.pendingMicrophones.delete(track);
      if (this.disposed) track?.stop();
      cleanup?.();
      throw error;
    }
    if (track) this.pendingMicrophones.delete(track);
    if (track) {
      this.localTracks.set(source, track);
      if (cleanup) this.trackCleanup.set(source, cleanup);
      else this.trackCleanup.delete(source);
      track.addEventListener(
        'ended',
        () => {
          if (!this.disposed && this.localTracks.get(source) === track)
            void this.setLocalTrack(source, null).catch((error) =>
              this.emit('error', { operation: `end-${source}`, error }),
            );
        },
        { once: true },
      );
    } else {
      this.localTracks.delete(source);
      this.trackCleanup.delete(source);
    }
    try {
      await Promise.all(
        [...this.peers.keys()].map((peerId) => this.sendMetadata(peerId)),
      );
    } finally {
      if (previous) previous.stop();
      previousCleanup?.();
    }
    if (source === 'screen') this.copilot.setSource(track);
    this.emit('local-track', { source, track });
    if (source === 'microphone') this.voiceRelay?.setMicrophone(track);
  }

  getLocalTracks(): ReadonlyMap<MediaSourceKind, MediaStreamTrack> {
    return new Map(this.localTracks);
  }

  /** Gate both the published mic and replacements waiting on sender promises. */
  setMicrophoneEnabled(enabled: boolean): void {
    this.microphoneEnabled = enabled;
    const microphone = this.localTracks.get('microphone');
    if (microphone) microphone.enabled = enabled;
    for (const track of this.pendingMicrophones) track.enabled = enabled;
  }

  /** Borrowed for local diagnostics only. Capture retains ownership. */
  getMicrophoneInput(): MediaStreamTrack | undefined {
    return this.microphoneInput?.readyState === 'live' ? this.microphoneInput : undefined;
  }

  getRemoteTracks(peerId?: string): RemoteTrack[] {
    const peers = peerId
      ? ([this.peers.get(peerId)].filter(Boolean) as Peer[])
      : [...this.peers.values()];
    return peers.flatMap((peer) => [...peer.remote.values()].filter(
      (track) => track.source !== 'microphone' || !this.relayTracks.has(track.peerId),
    )).concat(
      [...this.nativeRemote.values()].filter((track) =>
        (!peerId || track.peerId === peerId) && !this.peers.get(track.peerId)?.remote.has('screen')),
      [...this.relayTracks.values()].filter((track) => !peerId || track.peerId === peerId),
    );
  }

  addPeer(peerId: string): void {
    this.ensureActive();
    if (peerId === this.signaling.localPeerId || this.peers.has(peerId)) return;
    const config: RTCConfiguration = {
      iceServers: this.ice.iceServers ?? [],
      // 'relay' makes the browser gather only relay candidates (from the
      // one configured TURN server), so this peer's media physically
      // transits it regardless of what the other side does.
      iceTransportPolicy: this.ice.mode === 'relay-only' ? 'relay' : 'all',
      bundlePolicy: this.ice.bundlePolicy ?? 'max-bundle',
    };
    const pc = new RTCPeerConnection(config);
    const peer: Peer = {
      pc,
      polite: this.signaling.localPeerId.localeCompare(peerId) > 0,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      senders: new Map(),
      streams: new Map(),
      metadata: new Map(),
      remote: new Map(),
      pendingTracks: new Map(),
      pendingCandidates: [],
    };
    this.peers.set(peerId, peer);
    this.copilot.attach(peerId, pc);
    for (const [source, track] of this.localTracks) {
      if (source === 'screen' && this.nativeScreen.active) continue;
      const stream = new MediaStream([track]);
      peer.streams.set(source, stream);
      const sender = pc.addTrack(track, stream);
      peer.senders.set(source, sender);
      void this.applyQuality(sender);
    }
    pc.onnegotiationneeded = () => {
      void this.negotiate(peerId, peer);
    };
    pc.onicecandidate = ({ candidate }) => {
      if (
        candidate &&
        this.ice.mode === 'direct-only' &&
        isRelayCandidate(candidate.toJSON())
      )
        return;
      void this.send({
        type: 'ice-candidate',
        to: peerId,
        candidate: candidate?.toJSON() ?? null,
      });
    };
    pc.ontrack = (event) =>
      this.acceptRemoteTrack(
        peerId,
        peer,
        event.track,
        event.streams.map((stream) => stream.id),
      );
    pc.onconnectionstatechange = () => {
      this.emit('peer-state', { peerId, state: pc.connectionState });
      this.updateVoiceRoute(peerId);
      if (pc.connectionState === 'failed') pc.restartIce();
    };
    this.updateVoiceRoute(peerId);
    if (this.nativeScreen.active) void this.nativeScreen.addPeer(peerId);
    // Do not depend solely on negotiationneeded for the first offer. Some
    // WebRTC implementations can coalesce that event while both callers join.
    if (!peer.polite)
      queueMicrotask(() => {
        if (this.peers.get(peerId) === peer && !peer.pc.remoteDescription)
          void this.negotiate(peerId, peer);
      });
  }

  removePeer(peerId: string): void {
    this.copilot.detach(peerId);
    this.clearRelayTimer(peerId);
    clearTimeout(this.stableTimers.get(peerId));
    this.stableTimers.delete(peerId);
    this.voiceRelay?.stop(peerId);
    this.relayTracks.delete(peerId);
    this.relayStates.delete(peerId);
    this.directReady.delete(peerId);
    this.directProbe.delete(peerId);
    void this.nativeScreen.removePeer(peerId);
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(peerId);
    const removedSources = [...peer.remote.keys()];
    peer.remote.clear();
    peer.pendingTracks.clear();
    for (const source of removedSources)
      this.emit('remote-track-removed', { peerId, source });
  }

  async getScreenDiagnostics() { return this.nativeScreen.getDiagnostics(); }

  async handleSignal(signal: MediaSignal): Promise<void> {
    this.ensureActive();
    // Keep ordinary WebRTC signaling on its original synchronous path. An
    // unconditional await here lets a later candidate overtake its offer.
    if ('transport' in signal && signal.transport === 'native-screen') {
      const key = `native:${signal.from}:${signal.captureId}`;
      const previous = this.signalQueues.get(key) ?? Promise.resolve();
      const pending = previous.catch(() => undefined).then(async () => {
        if (!this.disposed) {
          try { await this.nativeScreen.handle(signal); }
          catch (error) { this.nativeScreen.noteSignalFailure(signal); throw error; }
        }
      });
      this.signalQueues.set(key, pending);
      try { await pending; }
      finally { if (this.signalQueues.get(key) === pending) this.signalQueues.delete(key); }
      return;
    }
    if ('transport' in signal && signal.transport === 'voice-relay') {
      if (!this.voiceRelay || !signal.from || !this.peers.has(signal.from)) return;
      if (signal.data.kind === 'direct-probe') {
        if (this.directReady.has(signal.from) && typeof signal.data.nonce === 'string' && signal.data.nonce.length <= 64) {
          await this.send({ type: 'signal', transport: 'voice-relay', to: signal.from, data: { kind: 'direct-ready', nonce: signal.data.nonce } });
        }
      } else if (signal.data.kind === 'direct-ready') {
        if (typeof signal.data.nonce === 'string' && this.directProbe.get(signal.from) === signal.data.nonce)
          this.restoreDirectVoice(signal.from);
      } else if (signal.data.kind === 'direct-unready') {
        this.directProbe.delete(signal.from);
        this.scheduleVoiceRelay(signal.from);
      } else {
        await this.voiceRelay.handleSignal(signal);
      }
      return;
    }
    const peerId = signal.from;
    if (!peerId)
      throw new Error('Inbound media signals require a from peer id');
    const previous = this.signalQueues.get(peerId) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => this.handleNormalSignal(peerId, signal));
    this.signalQueues.set(peerId, queued);
    try {
      await queued;
    } finally {
      if (this.signalQueues.get(peerId) === queued)
        this.signalQueues.delete(peerId);
    }
  }

  private async handleNormalSignal(
    peerId: string,
    signal: Exclude<MediaSignal, { type: 'signal' }>,
  ): Promise<void> {
    this.addPeer(peerId);
    const peer = this.peers.get(peerId)!;
    try {
      if (signal.type === 'track-metadata') {
        const advertisedSources = new Set(
          signal.tracks.map((track) => track.source),
        );
        for (const source of [...peer.remote.keys()]) {
          if (advertisedSources.has(source)) continue;
          peer.remote.delete(source);
          this.emit('remote-track-removed', { peerId, source });
        }
        peer.metadata = new Map(
          signal.tracks.map((track) => [track.trackId, track]),
        );
        for (const pending of [...peer.pendingTracks.values()])
          this.acceptRemoteTrack(
            peerId,
            peer,
            pending.track,
            pending.streamIds,
          );
        return;
      }
      if (signal.type === 'ice-candidate') {
        if (
          signal.candidate &&
          this.ice.mode === 'direct-only' &&
          isRelayCandidate(signal.candidate)
        )
          return;
        if (!peer.pc.remoteDescription)
          peer.pendingCandidates.push(signal.candidate);
        else {
          try {
            await peer.pc.addIceCandidate(signal.candidate);
          } catch (error) {
            // Candidates belonging to an intentionally ignored colliding offer
            // cannot be applied to the active remote description.
            if (!peer.ignoreOffer) throw error;
          }
        }
        return;
      }
      const description = signal.description;
      const readyForOffer =
        !peer.makingOffer &&
        (peer.pc.signalingState === 'stable' ||
          peer.isSettingRemoteAnswerPending);
      const offerCollision = description.type === 'offer' && !readyForOffer;
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      peer.isSettingRemoteAnswerPending = description.type === 'answer';
      await peer.pc.setRemoteDescription(description);
      peer.isSettingRemoteAnswerPending = false;
      for (const candidate of peer.pendingCandidates.splice(0))
        await peer.pc.addIceCandidate(candidate);
      if (description.type === 'offer') {
        await peer.pc.setLocalDescription();
        await this.send({
          type: 'answer',
          to: peerId,
          description: peer.pc.localDescription!.toJSON(),
        });
        await this.sendMetadata(peerId);
      }
      await Promise.all([...peer.senders.values()].map(sender => this.applyQuality(sender)));
    } catch (error) {
      this.emit('error', { peerId, operation: `handle-${signal.type}`, error });
      throw error;
    }
  }

  createRecording(
    includeRemote = true,
    mimeTypes?: string[],
  ): TrackRecordingSession {
    const tracks: RecordableTrack[] = [...this.localTracks].map(
      ([source, track]) => ({
        peerId: this.signaling.localPeerId,
        source,
        track,
      }),
    );
    if (includeRemote)
      tracks.push(
        ...this.getRemoteTracks().map(({ peerId, source, track }) => ({
          peerId,
          source,
          track,
        })),
      );
    const session = new TrackRecordingSession();
    session.start(tracks, mimeTypes);
    return session;
  }

  async setQuality(quality: MediaQualityOptions): Promise<void> {
    this.quality = { ...this.quality, ...quality };
    await Promise.all(
      [...this.peers.values()].flatMap((peer) =>
        [...peer.senders.values()].map((sender) => this.applyQuality(sender)),
      ),
    );
  }

  async getStats(peerId: string): Promise<PeerMediaStats> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Unknown peer: ${peerId}`);
    const report = await peer.pc.getStats();
    const rows = [...report.values()] as Array<Record<string, any>>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const selectedPair = rows.find(
      (row) =>
        row.type === 'candidate-pair' &&
        row.nominated &&
        row.state === 'succeeded',
    );
    const now = performance.now();
    const tracks = rows
      .filter(
        (row) => row.type === 'inbound-rtp' || row.type === 'outbound-rtp',
      )
      .map((row) => {
        const direction =
          row.type === 'inbound-rtp'
            ? ('inbound' as const)
            : ('outbound' as const);
        const bytes =
          Number(direction === 'inbound' ? row.bytesReceived : row.bytesSent) ||
          0;
        const key = `${peerId}:${row.id}`;
        const previous = this.previousStats.get(key);
        this.previousStats.set(key, { timestamp: row.timestamp, bytes });
        const bitrate =
          previous && row.timestamp > previous.timestamp
            ? Math.max(
                0,
                Math.round(
                  ((bytes - previous.bytes) * 8000) /
                    (row.timestamp - previous.timestamp),
                ),
              )
            : 0;
        const trackId = row.trackIdentifier;
        const descriptor = trackId ? peer.metadata.get(trackId) : undefined;
        const statsSender =
          direction === 'outbound'
            ? peer.pc
                .getTransceivers()
                .find((transceiver) => transceiver.mid === row.mid)?.sender
            : undefined;
        const localSource =
          direction === 'outbound'
            ? [...peer.senders].find(
                ([, sender]) =>
                  sender === statsSender || sender.track?.id === trackId,
              )?.[0]
            : descriptor?.source ?? [...peer.remote.values()].find(remote => remote.track.id === trackId)?.source;
        const audioSource = direction === 'outbound' ? byId.get(row.mediaSourceId) : row;
        const codec = byId.get(row.codecId);
        return {
          direction,
          source: localSource,
          mediaKind: row.kind ?? row.mediaType ?? 'unknown',
          bitrate,
          bytes,
          packets: Number(direction === 'inbound' ? row.packetsReceived : row.packetsSent) || 0,
          ...(typeof codec?.mimeType === 'string' ? { codec: codec.mimeType } : {}),
          ...(typeof audioSource?.audioLevel === 'number' ? { audioLevel: audioSource.audioLevel } : {}),
          ...(typeof audioSource?.totalAudioEnergy === 'number' ? { totalAudioEnergy: audioSource.totalAudioEnergy } : {}),
          ...(typeof row.totalSamplesReceived === 'number' ? { totalSamplesReceived: row.totalSamplesReceived } : {}),
          ...(typeof row.concealedSamples === 'number' ? { concealedSamples: row.concealedSamples } : {}),
          ...(row.frameWidth ? { width: row.frameWidth } : {}),
          ...(row.frameHeight ? { height: row.frameHeight } : {}),
          ...(row.framesPerSecond
            ? { framesPerSecond: row.framesPerSecond }
            : {}),
          ...(row.packetsLost !== undefined
            ? { packetsLost: row.packetsLost }
            : {}),
          ...(row.jitter !== undefined ? { jitterMs: row.jitter * 1000 } : {}),
          ...(localSource === 'screen' && descriptor?.screenTransport
            ? { screenTransport: descriptor.screenTransport }
            : {}),
        };
      });
    const local = selectedPair
      ? byId.get(selectedPair.localCandidateId)
      : undefined;
    const remote = selectedPair
      ? byId.get(selectedPair.remoteCandidateId)
      : undefined;
    return {
      peerId,
      timestamp: now,
      connectionState: peer.pc.connectionState,
      nativeScreen: await this.nativeScreen.getReceiverStats(peerId).catch(() => undefined),
      ...(this.relayStates.has(peerId) ? { voiceRelay: {
        ...this.relayStates.get(peerId)!,
        verificationCode: await this.voiceRelay?.getVerificationCode(peerId) ?? undefined,
      } } : {}),
      tracks,
      ...(selectedPair
        ? {
            route: {
              localCandidateType: local?.candidateType,
              remoteCandidateType: remote?.candidateType,
              protocol: local?.protocol,
              currentRoundTripTimeMs:
                selectedPair.currentRoundTripTime === undefined
                  ? undefined
                  : selectedPair.currentRoundTripTime * 1000,
            },
          }
        : {}),
    };
  }

  attachPeerAudio(
    peerId: string,
    element: HTMLAudioElement,
    options?: AudioLevelerOptions,
  ): AudioLeveler | null {
    const tracks = this.getRemoteTracks(peerId)
      .filter(({ track }) => track.kind === 'audio')
      .map(({ track }) => track);
    element.srcObject = new MediaStream(tracks);
    element.autoplay = true;
    if (!options || !tracks.length) return null;
    const context = new AudioContext();
    const leveler = new AudioLeveler(
      element.srcObject as MediaStream,
      context.destination,
      options,
    );
    element.muted = true;
    void context.resume();
    return leveler;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.copilot.dispose();
    for (const track of this.pendingMicrophones) track.stop();
    this.pendingMicrophones.clear();
    this.voiceRelay?.dispose();
    ++this.nativeShareGeneration;
    void this.stopNativeSystemAudio();
    this.nativeScreen.dispose();
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    for (const track of this.localTracks.values()) track.stop();
    for (const cleanup of this.trackCleanup.values()) cleanup();
    this.trackCleanup.clear();
    this.localTracks.clear();
    this.microphoneInput = undefined;
  }

  private setNativePreview(track: MediaStreamTrack | null) {
    const previous = this.localTracks.get('screen');
    if (previous && previous !== track) previous.stop();
    if (track) {
      // This decoded native track is also used by the compatibility sender.
      // Prefer preserving text/detail instead of silently scaling the picture.
      track.contentHint = this.nativeScreen.compatibilityContentHint;
      this.localTracks.set('screen', track);
      track.addEventListener('ended', () => {
        if (this.localTracks.get('screen') !== track) return;
        void this.nativeScreen.stop();
      }, { once: true });
    }
    else {
      this.localTracks.delete('screen');
      this.clearNativeScreenFallbacks();
      void this.stopNativeSystemAudio().catch(error => this.emit('error', { operation: 'stop-system-audio', error }));
    }
    this.copilot.setSource(track);
    this.emit('local-track', { source: 'screen', track });
  }

  private async negotiate(peerId: string, peer: Peer): Promise<void> {
    // On first contact, only the deterministic impolite side offers. Both peers
    // already have their local tracks attached, so the answer remains sendrecv.
    // Later changes may be initiated by either side once a remote description exists.
    if (peer.polite && !peer.pc.remoteDescription) return;
    if (peer.makingOffer || peer.pc.signalingState !== 'stable') return;
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      await Promise.all([...peer.senders.values()].map(sender => this.applyQuality(sender)));
      await this.send({
        type: 'offer',
        to: peerId,
        description: peer.pc.localDescription!.toJSON(),
      });
      await this.sendMetadata(peerId);
    } catch (error) {
      this.emit('error', { peerId, operation: 'negotiate', error });
    } finally {
      peer.makingOffer = false;
    }
  }

  private acceptRemoteTrack(
    peerId: string,
    peer: Peer,
    track: MediaStreamTrack,
    streamIds: string[],
  ): void {
    const descriptor = findTrackDescriptor(
      peer.metadata.values(),
      track.id,
      streamIds,
    );
    if (!descriptor) {
      peer.pendingTracks.set(track.id, { track, streamIds });
      return;
    }
    peer.pendingTracks.delete(track.id);
    const existing = peer.remote.get(descriptor.source);
    if (existing?.track === track) return;
    if (existing)
      this.emit('remote-track-removed', { peerId, source: descriptor.source });
    const remote = {
      peerId,
      source: descriptor.source,
      track,
      stream: new MediaStream([track]),
      ...(descriptor.source === 'screen' && descriptor.screenTransport
        ? { screenTransport: descriptor.screenTransport }
        : {}),
    };
    if (descriptor.source === 'screen' && this.nativeRemote.delete(peerId))
      this.nativeScreen.finishReceiverFallback(peerId);
    peer.remote.set(descriptor.source, remote);
    track.addEventListener(
      'ended',
      () => {
        if (peer.remote.get(descriptor.source)?.track !== track) return;
        peer.remote.delete(descriptor.source);
        this.emit('remote-track-removed', {
          peerId,
          source: descriptor.source,
        });
      },
      { once: true },
    );
    if (descriptor.source !== 'microphone' || !this.relayTracks.has(peerId))
      this.emit('remote-track', remote);
  }

  private clearRelayTimer(peerId: string): void {
    clearTimeout(this.relayTimers.get(peerId));
    this.relayTimers.delete(peerId);
  }

  private updateVoiceRoute(peerId: string): void {
    if (!this.voiceRelay) return;
    this.clearRelayTimer(peerId);
    clearTimeout(this.stableTimers.get(peerId));
    this.stableTimers.delete(peerId);
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (peer.pc.connectionState === 'connected' && this.relayMode === 'automatic') {
      // Both ends must see a stable RTC path before either stops the fallback.
      this.stableTimers.set(peerId, setTimeout(() => {
        this.stableTimers.delete(peerId);
        if (this.peers.get(peerId) !== peer || peer.pc.connectionState !== 'connected') return;
        this.directReady.add(peerId);
        const nonce = crypto.randomUUID();
        this.directProbe.set(peerId, nonce);
        void this.send({ type: 'signal', transport: 'voice-relay', to: peerId, data: { kind: 'direct-probe', nonce } });
      }, 5000));
    } else {
      this.directReady.delete(peerId);
      this.directProbe.delete(peerId);
      void this.send({ type: 'signal', transport: 'voice-relay', to: peerId, data: { kind: 'direct-unready' } });
      this.scheduleVoiceRelay(peerId);
    }
  }

  private scheduleVoiceRelay(peerId: string): void {
    if (!this.voiceRelay) return;
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.clearRelayTimer(peerId);
    this.relayTimers.set(peerId, setTimeout(() => {
        this.relayTimers.delete(peerId);
        if (this.disposed || this.peers.get(peerId) !== peer) return;
        void this.voiceRelay!.start(peerId).catch(error => {
          this.relayStates.set(peerId, { state: 'unavailable', message: error instanceof Error ? error.message : String(error) });
        });
      }, this.relayMode === 'relay' ? 0 : 8000));
  }

  private restoreDirectVoice(peerId: string): void {
    if (!this.directReady.has(peerId)) return;
    this.clearRelayTimer(peerId);
    this.directProbe.delete(peerId);
    this.voiceRelay?.stop(peerId);
    this.relayStates.delete(peerId);
  }

  private async sendMetadata(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    const tracks: TrackDescriptor[] = [...this.localTracks]
      .filter(([source]) =>
        source !== 'screen' || !this.nativeScreen.active || peer?.senders.has('screen'))
      .map(
      ([source, track]) => ({
        source,
        trackId: track.id,
        mediaKind: track.kind as 'audio' | 'video',
        enabled: track.enabled,
        streamId: peer?.streams.get(source)?.id,
        ...(source === 'screen' ? {
          screenTransport: this.nativeScreen.active
            ? 'native-compatibility' as const
            : 'browser' as const,
        } : {}),
      }),
    );
    await this.send({ type: 'track-metadata', to: peerId, tracks });
  }

  private async enableNativeScreenFallback(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    const track = this.localTracks.get('screen');
    if (!peer || !track || track.readyState !== 'live' || !this.nativeScreen.active)
      throw new Error('Native screen fallback is no longer available');
    if (peer.senders.has('screen')) return;
    const stream = new MediaStream([track]);
    const sender = peer.pc.addTrack(track, stream);
    peer.streams.set('screen', stream);
    peer.senders.set('screen', sender);
    await this.applyQuality(sender);
    await this.sendMetadata(peerId);
    await this.negotiate(peerId, peer);
  }

  private clearNativeScreenFallbacks(): void {
    for (const [peerId, peer] of this.peers) {
      const sender = peer.senders.get('screen');
      if (!sender) continue;
      peer.pc.removeTrack(sender);
      peer.senders.delete('screen');
      peer.streams.delete('screen');
      void this.sendMetadata(peerId).then(() => this.negotiate(peerId, peer)).catch(error =>
        this.emit('error', { peerId, operation: 'stop-native-screen-fallback', error }));
    }
  }

  private async send(signal: MediaSignal): Promise<void> {
    await this.signaling.send(signal);
  }

  private emit<K extends keyof MediaEngineEventMap>(
    type: K,
    detail: MediaEngineEventMap[K]['detail'],
  ): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private assertSourceKind(
    source: MediaSourceKind,
    track: MediaStreamTrack,
  ): void {
    const expected =
      source === 'camera' || source === 'screen' ? 'video' : 'audio';
    if (track.kind !== expected)
      throw new TypeError(`${source} requires a ${expected} track`);
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('MediaEngine has been disposed');
  }

  private async applyQuality(sender: RTCRtpSender): Promise<void> {
    if (!sender.track) return;
    const parameters = sender.getParameters();
    // Encoding entries are owned by WebRTC. A new sender may have none until
    // negotiation; inventing one makes setParameters reject and can break capture.
    // Reapply after SDP negotiation when the browser exposes the actual entries.
    if (!parameters.encodings?.length) return;
    const isScreen =
      sender.track.kind === 'video' &&
      sender.track === this.localTracks.get('screen');
    const nativeCompatibility = isScreen && this.nativeScreen.active;
    const quality = nativeCompatibility
      ? this.nativeScreen.compatibilityQuality ?? this.quality
      : this.quality;
    let changed = false;
    // Every screen sender degrades by dropping frames rather than resolution.
    // Motion content is the one case where the reverse reads better.
    const hint = nativeCompatibility
      ? this.nativeScreen.compatibilityContentHint
      : sender.track.contentHint;
    const preference = isScreen
      ? hint === 'motion'
        ? 'balanced'
        : 'maintain-resolution'
      : undefined;
    if (preference && parameters.degradationPreference !== preference) {
      parameters.degradationPreference = preference;
      changed = true;
    }
    for (const encoding of parameters.encodings) {
      if (sender.track.kind === 'audio') {
        if (quality.maxAudioBitrate !== undefined && encoding.maxBitrate !== quality.maxAudioBitrate) {
          encoding.maxBitrate = quality.maxAudioBitrate;
          changed = true;
        }
      } else {
        if (quality.maxVideoBitrate !== undefined && encoding.maxBitrate !== quality.maxVideoBitrate) {
          encoding.maxBitrate = quality.maxVideoBitrate;
          changed = true;
        }
        if (quality.maxFramerate !== undefined && encoding.maxFramerate !== quality.maxFramerate) {
          encoding.maxFramerate = quality.maxFramerate;
          changed = true;
        }
        if (quality.scaleResolutionDownBy !== undefined && encoding.scaleResolutionDownBy !== quality.scaleResolutionDownBy) {
          encoding.scaleResolutionDownBy = quality.scaleResolutionDownBy;
          changed = true;
        }
      }
    }
    if (changed) await sender.setParameters(parameters);
  }
}
