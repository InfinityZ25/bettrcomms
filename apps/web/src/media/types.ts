export type MediaSourceKind = 'camera' | 'microphone' | 'screen' | 'system';

export interface TrackDescriptor {
  source: MediaSourceKind;
  trackId: string;
  mediaKind: 'audio' | 'video';
  enabled: boolean;
  streamId?: string;
}

export type SessionDescriptionSignal = {
  type: 'offer' | 'answer';
  to: string;
  from?: string;
  description: RTCSessionDescriptionInit;
  transport?: 'native-screen';
  captureId?: string;
};

export type IceCandidateSignal = {
  type: 'ice-candidate';
  to: string;
  from?: string;
  candidate: RTCIceCandidateInit | null;
  transport?: 'native-screen';
  captureId?: string;
};

export type NativeScreenStopSignal = {
  type: 'signal';
  to: string;
  from?: string;
  transport: 'native-screen';
  captureId: string;
  data: { kind: 'native-screen-stop'; captureId: string };
};

export type TrackMetadataSignal = {
  type: 'track-metadata';
  to: string;
  from?: string;
  tracks: TrackDescriptor[];
};

export type MediaSignal =
  | SessionDescriptionSignal
  | IceCandidateSignal
  | TrackMetadataSignal
  | NativeScreenStopSignal
  | VoiceRelaySignal;

export type VoiceRelaySignal = {
  type: 'signal';
  transport: 'voice-relay';
  to: string;
  from?: string;
  data: { kind: string; [key: string]: unknown };
};

export interface SignalingAdapter {
  readonly localPeerId: string;
  send(signal: MediaSignal): void | Promise<void>;
}

export interface RemoteTrack {
  peerId: string;
  source: MediaSourceKind;
  track: MediaStreamTrack;
  stream: MediaStream;
}

export interface CaptureOptions {
  camera?: boolean | MediaTrackConstraints;
  microphone?: boolean | MediaTrackConstraints;
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  denoiser?: 'standard' | 'rnnoise' | 'speex' | 'nvidia' | 'deepfilter' | 'off';
  processing?: MicrophoneProcessingSettings;
}

export interface MicrophoneProcessingSettings {
  engine: 'standard' | 'rnnoise' | 'speex' | 'nvidia' | 'deepfilter' | 'off';
  echoCancellation: boolean;
  autoGainControl: boolean;
  nvidiaIntensity: number;
  nvidiaVad: boolean;
  deepfilterAttenuationDb: number;
  highPassHz: number;
  gainDb: number;
  gateEnabled: boolean;
  gateThresholdDb: number;
  gateAttackMs: number;
  gateHoldMs: number;
  gateReleaseMs: number;
}

export interface ScreenCaptureOptions {
  video?: boolean | MediaTrackConstraints;
  systemAudio?: boolean;
}

export interface IceOptions {
  mode?: 'direct-only' | 'direct-preferred';
  iceServers?: RTCIceServer[];
  bundlePolicy?: RTCBundlePolicy;
}

export interface MediaQualityOptions {
  /** Maximum encoded audio bitrate in bits per second. Defaults to 256 kbps. */
  maxAudioBitrate?: number;
  /** Maximum encoded video bitrate in bits per second. */
  maxVideoBitrate?: number;
  maxFramerate?: number;
  scaleResolutionDownBy?: number;
}

export interface PeerMediaStats {
  peerId: string;
  timestamp: number;
  connectionState: RTCPeerConnectionState;
  voiceRelay?: {
    state: 'connecting' | 'relayed' | 'unavailable';
    message?: string;
    verificationCode?: string;
  };
  route?: {
    localCandidateType?: RTCIceCandidateType;
    remoteCandidateType?: RTCIceCandidateType;
    protocol?: string;
    currentRoundTripTimeMs?: number;
  };
  tracks: Array<{
    direction: 'inbound' | 'outbound';
    source?: MediaSourceKind;
    mediaKind: string;
    bitrate: number;
    width?: number;
    height?: number;
    framesPerSecond?: number;
    packetsLost?: number;
    jitterMs?: number;
  }>;
}

export type MediaEngineEventMap = {
  'local-track': CustomEvent<{
    source: MediaSourceKind;
    track: MediaStreamTrack | null;
  }>;
  'remote-track': CustomEvent<RemoteTrack>;
  'remote-track-removed': CustomEvent<{
    peerId: string;
    source: MediaSourceKind;
  }>;
  'peer-state': CustomEvent<{ peerId: string; state: RTCPeerConnectionState }>;
  error: CustomEvent<{ peerId?: string; operation: string; error: unknown }>;
  'denoiser-status': CustomEvent<{
    requested: 'nvidia' | 'deepfilter';
    active: 'nvidia' | 'deepfilter' | 'rnnoise';
    message: string;
  }>;
};

export interface RecordingTrackManifest {
  id: string;
  peerId: string;
  source: MediaSourceKind;
  mediaKind: 'audio' | 'video';
  mimeType: string;
  fileName: string;
  startedOffsetMs: number;
  durationMs: number;
  bytes: number;
  status: 'complete' | 'empty' | 'unsupported' | 'error';
  endedReason:
    'session-stopped' | 'track-ended' | 'size-limit' | 'recorder-error';
  error?: string;
}

export interface RecordingManifest {
  version: 1;
  recordingId: string;
  startedAt: string;
  stoppedAt: string;
  tracks: RecordingTrackManifest[];
  replay: {
    status: 'available' | 'unsupported';
    boundedSeconds?: number;
    reason?: string;
  };
}

export interface RecordingFile {
  name: string;
  blob: Blob;
}

export interface RecordingResult {
  manifest: RecordingManifest;
  files: RecordingFile[];
}
