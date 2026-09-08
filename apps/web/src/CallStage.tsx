import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type WheelEvent as ReactWheelEvent, type CSSProperties } from 'react';
import { CallMicrophone, talkBindingLabel } from './media/pushToTalk';
import { RecordingDownload } from './RecordingDownload';
import ConnectionStatus from './ConnectionStatus';
import { useSpeakingActivity } from './media/useSpeakingActivity';
import {
  Circle,
  Download,
  Headphones,
  Maximize2,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Radio,
  ShieldCheck,
  Square,
  Video,
  VideoOff,
  Volume2,
  ZoomIn,
  ZoomOut,
  Plus,
  Pin,
  LayoutGrid,
  X,
} from 'lucide-react';
import { Button } from './components/ui/button';
import {
  MediaEngine,
  RoomWebSocketSignaling,
  TrackRecordingSession,
  type MediaSourceKind,
  type RemoteTrack,
  type RecordingResult,
} from './media';
import { api, type User, type Room } from './api';
import { attachRemoteAudio, prepareCallPlayback, disposeCallPlayback, readParticipantVolume, getCallPlaybackStatus } from './media/remoteAudio';
import { allowDesktopCapture } from './media/permissions';
import { saveRecording } from './media/recordingLibrary';
import { readRecordingQuality } from './media/recordingQuality';
import { microphoneCaptureOptions, readProcessingSettings } from './media/processingSettings';
import { readSpeakingThreshold } from './media/speakingSensitivity';
import {
  cameraCaptureConstraints,
  readCameraSettings,
} from './media/cameraSettings';
import { readQuality } from './MediaSettings';
import type { PeerMediaStats } from './media';
import { isTauri } from '@tauri-apps/api/core';
import type { NativeScreenStartOptions } from './media/nativeScreen';
import { setCallPlaybackDeafened } from './media/remoteAudio';
import { saveRecordingAsset } from './media/recordingExport';
import './CallLobby.css';
import './CallWorkspace.css';
import { useCallLayout } from './useCallLayout';
import CameraOverlay from './CameraOverlay';

export interface CallPresence {
  user_id: string;
  name?: string;
  muted: boolean;
  deafened: boolean;
  device_count: number;
}
const EMPTY_CALL_PRESENCE: CallPresence[] = [];
type GalleryLayout = 'adaptive' | 'grid' | 'focus' | 'all';
type StageItem = {
  key: string;
  kind: 'screen' | 'camera';
  name: string;
  track: MediaStreamTrack;
  self?: boolean;
  /** The sender fell back to re-encoding this screen through the call. */
  reencoded?: boolean;
};

function readGalleryLayout(): GalleryLayout {
  try {
    const value = localStorage.getItem('bc-gallery-layout');
    return value === 'grid' || value === 'focus' || value === 'all' ? value : 'adaptive';
  } catch { return 'adaptive'; }
}

export interface NativeShareActions {
  onShare(options: NativeScreenStartOptions): Promise<void>;
  onBrowser(): Promise<void>;
  onClose(): void;
}

export default function CallStage({
  user,
  room,
  layout,
  onLayout,
  onJoinedChange,
  focused = false,
  onFocus,
  noise,
  balanced,
  onError,
  onInvite,
  onRecordings,
  onRequestShare,
  callPresence = EMPTY_CALL_PRESENCE,
  presenceKnown = true,
}: {
  user: User | null;
  room: Room | null;
  layout: string;
  onLayout?: (layout: string) => void;
  onJoinedChange?: (joined: boolean) => void;
  focused?: boolean;
  onFocus?: () => void;
  noise: boolean;
  balanced: boolean;
  onError: (s: string) => void;
  onInvite: () => void;
  onRecordings: () => void;
  onRequestShare: (actions: NativeShareActions) => void;
  callPresence?: CallPresence[];
  presenceKnown?: boolean;
}) {
  const [joined, setJoined] = useState(false),
    [busy, setBusy] = useState(false),
    [locals, setLocals] = useState<Map<MediaSourceKind, MediaStreamTrack>>(
      new Map(),
    ),
    [remote, setRemote] = useState<RemoteTrack[]>([]),
    [peers, setPeers] = useState<Record<string, string>>({}),
    [names, setNames] = useState<Record<string, string>>({}),
    [recording, setRecording] = useState(false),
    [result, setResult] = useState<RecordingResult | null>(null),
    [watchedShareIds, setWatchedShareIds] = useState<string[]>([]),
    [focusedStageKey, setFocusedStageKey] = useState<string | null>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const docking = useCallLayout(layout, onLayout, joined);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastControlsPointer = useRef({ x: Number.NaN, y: Number.NaN });
  const [cameraAspects, setCameraAspects] = useState<Record<string, number>>({});
  const [contentFit, setContentFit] = useState<'fit' | 'fill'>(() => {
    try { return localStorage.getItem('bc-content-fit') === 'fill' ? 'fill' : 'fit'; }
    catch { return 'fit'; }
  });
  const [galleryLayout, setGalleryLayout] = useState<GalleryLayout>(readGalleryLayout);
  const [galleryFit, setGalleryFit] = useState<'cover' | 'contain'>(() => {
    try { return localStorage.getItem('bc-gallery-fit') === 'contain' ? 'contain' : 'cover'; }
    catch { return 'cover'; }
  });
  const [featuredCamera, setFeaturedCamera] = useState('self');
  useEffect(() => { onJoinedChange?.(joined); }, [joined, onJoinedChange]);
  useEffect(() => {
    const update = () => {
      setFullscreen(document.fullscreenElement === workspace.current && Boolean(workspace.current));
      setControlsVisible(true);
    };
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => () => { if (controlsTimer.current) clearTimeout(controlsTimer.current); }, []);
  const revealControls = () => {
    setControlsVisible(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    if (fullscreen) controlsTimer.current = setTimeout(() => setControlsVisible(false), 2400);
  };
  const pointerActivity = (event: PointerEvent<HTMLDivElement>) => {
    const previous = lastControlsPointer.current;
    if (previous.x === event.clientX && previous.y === event.clientY) return;
    lastControlsPointer.current = { x: event.clientX, y: event.clientY };
    revealControls();
  };
  useEffect(() => {
    if (!fullscreen) return;
    revealControls();
    return () => { if (controlsTimer.current) clearTimeout(controlsTimer.current); };
  }, [fullscreen]);
  const toggleFullscreen = () => {
    const action = document.fullscreenElement ? document.exitFullscreen() : workspace.current?.requestFullscreen();
    void action?.catch(error => onError(error.message));
  };
  const engine = useRef<MediaEngine | null>(null),
    socket = useRef<RoomWebSocketSignaling | null>(null),
    recorder = useRef<TrackRecordingSession | null>(null),
    shareRequest = useRef(0),
    active = useRef(true);
  const [callMicrophone] = useState(() => new CallMicrophone(enabled => engine.current?.setMicrophoneEnabled(enabled)));
  const { muted, transmitting, deafened, manualMuted, settings: talkSettings, globalStatus, globalMessage } = useSyncExternalStore(callMicrophone.subscribe, callMicrophone.getSnapshot);
  const [remotePresence, setRemotePresence] = useState<Record<string, { muted: boolean; deafened: boolean }>>({});
  const [stats, setStats] = useState<PeerMediaStats[]>([]),
    [showStats, setShowStats] = useState(false),
    [remoteRecording, setRemoteRecording] = useState<Record<string, boolean>>(
      {},
    ),
    [audioBlocked, setAudioBlocked] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [serverRtt, setServerRtt] = useState<number | null>(null);
  const [reportStatus, setReportStatus] = useState('');
  async function downloadDiagnostics() {
    try {
      const nativeVersion = isTauri() ? await import('@tauri-apps/api/app').then(api => api.getVersion()).catch(() => 'unknown') : undefined;
      const report = {
        version: 2, time: new Date().toISOString(), client: { native: isTauri(), nativeVersion, userAgent: navigator.userAgent },
        serverRtt, playback: getCallPlaybackStatus(), screen: await engine.current?.getScreenDiagnostics(),
        peers: stats.map(({ peerId: _id, voiceRelay, ...peer }, index) => ({ peer: index + 1, ...peer, voiceRelay: voiceRelay ? { state: voiceRelay.state } : undefined })),
        videoElements: [...(workspace.current?.querySelectorAll('video') ?? [])].map(video => ({ self: video.classList.contains('self-video'), readyState: video.readyState, paused: video.paused, width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime, errorCode: video.error?.code })),
      };
      const file = { name: 'bettercomms-diagnostics-' + Date.now() + '.json', blob: new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }) };
      if (isTauri()) await saveRecordingAsset(file, new AbortController().signal, () => {});
      else { const url = URL.createObjectURL(file.blob); const link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
      setReportStatus('Diagnostics exported. No call content, addresses, or credentials included.');
    } catch { setReportStatus('Could not export diagnostics. Try again while the call is open.'); }
  }
  const microphone = locals.get('microphone');
  const speaking = useSpeakingActivity(
    [
      ...(microphone && !muted ? [{ id: 'self', track: microphone }] : []),
      ...remote
        .filter(
          (t) => t.source === 'microphone' && (peers[t.peerId] === 'connected' || stats.some(s => s.peerId === t.peerId && s.voiceRelay?.state === 'relayed')),
        )
        .map((t) => ({ id: t.peerId, track: t.track })),
    ],
    joined,
  );
  const recordingMetadata = useRef({
    title: 'Call recording',
    labels: {} as Record<string, string>,
  });
  const archiveRecording = async (
    result: RecordingResult,
    metadata: { title: string; labels: Record<string, string> },
  ) => {
    if (active.current) {
      setResult(result);
      setSaveStatus('Saving recording…');
    }
    try {
      await saveRecording(result, metadata);
      if (active.current)
        setSaveStatus('Saved to your recordings on this device.');
    } catch (error) {
      if (active.current) {
        setSaveStatus(
          'Not saved. Download the original tracks below before closing.',
        );
        onError(error instanceof Error ? error.message : String(error));
      }
    }
  };
  useEffect(() => {
    if (recorder.current)
      Object.assign(recordingMetadata.current.labels, names);
  }, [names]);
  useEffect(() => {
    const snapshot = Object.fromEntries(callPresence.map((presence) => [
      presence.user_id, { muted: presence.muted, deafened: presence.deafened },
    ]));
    setRemotePresence((current) => {
      if (!joined) return snapshot;
      const merged = { ...current };
      for (const [peerId, value] of Object.entries(snapshot))
        if (!(peerId in merged)) merged[peerId] = value;
      return merged;
    });
  }, [callPresence, joined]);
  const recordedTracks = useRef(new Set<string>());
  const finishRecording = async () => {
    const current = recorder.current;
    const metadata = recordingMetadata.current;
    recorder.current = null;
    recordedTracks.current.clear();
    setRecording(false);
    if (current)
      try {
        const result = await current.stop();
        await archiveRecording(result, metadata);
      } catch (error) {
        if (active.current)
          onError(error instanceof Error ? error.message : String(error));
      }
  };
  const leave = () => {
    callMicrophone.stop();
    disposeCallPlayback();
    void finishRecording();
    socket.current?.close();
    socket.current = null;
    engine.current?.dispose();
    engine.current = null;
    setJoined(false);
    setServerRtt(null);
    setStats([]);
    setLocals(new Map());
    setRemote([]);
    setPeers({});
    setRemoteRecording({});
    setRemotePresence({});
    setWatchedShareIds([]);
    setFocusedStageKey(null);
    setCallPlaybackDeafened(false);
  };
  useEffect(() => {
    active.current = true;
    const blocked = () => setAudioBlocked(true);
    window.addEventListener('bc-audio-blocked', blocked);
    return () => {
      window.removeEventListener('bc-audio-blocked', blocked);
      active.current = false;
      socket.current?.close();
      engine.current?.dispose();
      disposeCallPlayback();
      const metadata = recordingMetadata.current;
      void recorder.current
        ?.stop()
        .then((result) => archiveRecording(result, metadata))
        .catch(() => {});
      recorder.current = null;
    };
  }, []);
  useEffect(() => {
    leave();
  }, [room?.id, user?.id]);
  useEffect(() => {
    const update = async () => {
      const e = engine.current;
      if (!e) return;
      try {
        await e.captureUserMedia({
          camera: false,
          ...microphoneCaptureOptions(localStorage.getItem('bc-input') ?? ''),
        });
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    };
    void update();
    window.addEventListener('bc-denoiser', update);
    window.addEventListener('bc-processing', update);
    return () => {
      window.removeEventListener('bc-denoiser', update);
      window.removeEventListener('bc-processing', update);
    };
  }, [noise]);
  useEffect(() => {
    if (!recording || !recorder.current || !user) return;
    const current = [...locals]
      .map(([source, track]) => ({ peerId: user.id, source, track }))
      .concat(
        remote.map((t) => ({
          peerId: t.peerId,
          source: t.source,
          track: t.track,
        })),
      );
    const ids = new Set(current.map((t) => t.track.id));
    for (const id of recordedTracks.current)
      if (!ids.has(id)) recorder.current.removeTrack(id);
    for (const track of current) recorder.current.addTrack(track);
    recordedTracks.current = ids;
  }, [locals, remote, recording, user?.id]);
  useEffect(() => {
    if (joined)
      try {
        socket.current?.sendPresence({
          camera: locals.has('camera'),
          microphone: !muted,
          sharing: locals.has('screen'),
          recording,
          muted,
          deafened,
        });
      } catch {}
  }, [joined, locals, muted, deafened, recording, Object.keys(peers).join(',')]);
  useEffect(() => {
    const handler = () => {
      engine.current
        ?.setQuality(readQuality())
        .catch((e) => onError(e.message));
    };
    window.addEventListener('bc-quality', handler);
    return () => window.removeEventListener('bc-quality', handler);
  }, []);
  useEffect(() => {
    if (!room || !user) return;
    let live = true;
    api<{ members: { user: User }[] }>('/rooms/' + room.id + '/members')
      .then((r) => {
        if (live)
          setNames((current) => ({
            ...Object.fromEntries(r.members.map((m) => [m.user.id, m.user.name])),
            // Signaling identities are keyed by per-device peer IDs. Keep
            // those entries when the durable room-member snapshot refreshes.
            ...current,
          }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [room?.id, user?.id, Object.keys(peers).join(',')]);
  useEffect(() => {
    if (!joined) return;
    let live = true;
    let pending = false;
    const poll = () => {
      const e = engine.current;
      if (e && !pending) {
        pending = true;
        Promise.all(
          Object.keys(peers).map((id) => e.getStats(id).catch(() => null)),
        )
          .then((r) => {
            if (live)
              setStats(r.filter((s): s is PeerMediaStats => s !== null));
          })
          .finally(() => {
            pending = false;
          });
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [joined, Object.keys(peers).join(',')]);
  useEffect(() => {
    const handler = async () => {
      const e = engine.current;
      if (!e) return;
      try {
        await e.captureUserMedia({
          ...microphoneCaptureOptions(localStorage.getItem('bc-input') ?? ''),
          camera: e.getLocalTracks().has('camera')
            ? cameraCaptureConstraints(
                localStorage.getItem('bc-camera') ?? '',
                readCameraSettings(),
              )
            : false,
        });
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    };
    window.addEventListener('bc-devices', handler);
    return () => window.removeEventListener('bc-devices', handler);
  }, [noise, muted]);
  useEffect(() => {
    let current = 0;
    let pending = Promise.resolve();
    const handler = () => {
      const request = ++current;
      pending = pending.then(async () => {
        if (request !== current) return;
        const e = engine.current;
        if (!e?.getLocalTracks().has('camera')) return;
        try {
          await e.captureUserMedia({
            camera: cameraCaptureConstraints(
              localStorage.getItem('bc-camera') ?? '',
              readCameraSettings(),
            ),
            microphone: false,
          });
        } catch (error) {
          if (request === current)
            onError(error instanceof Error ? error.message : String(error));
        }
      });
    };
    window.addEventListener('bc-camera-quality', handler);
    return () => {
      current += 1;
      window.removeEventListener('bc-camera-quality', handler);
    };
  }, [onError]);
  async function perform(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function join(joinMode: 'replace' | 'additional' = 'replace') {
    if (!user) {
      location.assign('/api/v1/auth/login');
      return;
    }
    if (!room) {
      onError('Create a room before joining a call.');
      return;
    }
    prepareCallPlayback();
    await perform(async () => {
      await allowDesktopCapture('microphone');
      const config = await api<{ ice_servers: RTCIceServer[] }>('/ice').catch(
        () => api<{ ice_servers: RTCIceServer[] }>('/config'),
      );
      const peerId = createCallPeerId();
      const query = new URLSearchParams({ peer_id: peerId, join_mode: joinMode });
      const s = new RoomWebSocketSignaling(
        peerId,
        `/api/v1/rooms/${room.id}/ws?${query}`,
      );
      const e = new MediaEngine({
        signaling: s,
        voiceRelay: {
          url: `/api/v1/rooms/${room.id}/voice-relay?peer_id=${encodeURIComponent(peerId)}`,
          mode: localStorage.getItem('bc-voice-route') === 'relay' ? 'relay' : 'automatic',
        },
        quality: readQuality(),
        ice: {
          mode:
            localStorage.getItem('bc-direct') === 'true'
              ? 'direct-only'
              : 'direct-preferred',
          iceServers: config.ice_servers,
        },
      });
      engine.current = e;
      callMicrophone.start();
      socket.current = s;
      s.addEventListener('latency', (event) => {
        if (socket.current === s) setServerRtt(event.detail.rttMs);
      });
      e.addEventListener('local-track', () =>
        setLocals(new Map(e.getLocalTracks())),
      );
      e.addEventListener('remote-track', () => setRemote(e.getRemoteTracks()));
      e.addEventListener('remote-track-removed', () =>
        setRemote(e.getRemoteTracks()),
      );
      e.addEventListener('peer-state', (event) =>
        setPeers((p) => ({ ...p, [event.detail.peerId]: event.detail.state })),
      );
      e.addEventListener('error', (event) =>
        onError(
          'Media: ' +
            (event.detail.error instanceof Error
              ? event.detail.error.message
              : String(event.detail.error)),
        ),
      );
      e.addEventListener('denoiser-status', (event) =>
        onError(event.detail.message),
      );
      s.addEventListener('peers', (event) => {
        for (const id of event.detail.peerIds) {
          e.addPeer(id);
          setPeers((p) => ({ ...p, [id]: 'connecting' }));
        }
        setNames(current => {
          const next = { ...current };
          for (const [id, identity] of Object.entries(event.detail.identities)) {
            if (identity.name) next[id] = identity.name;
          }
          return next;
        });
      });
      s.addEventListener('signal', (event) => {
        void e
          .handleSignal(event.detail)
          .catch((error) => onError(error.message));
      });
      s.addEventListener('peer-joined', (event) => {
        e.addPeer(event.detail.peerId);
        setPeers((p) => ({ ...p, [event.detail.peerId]: 'connecting' }));
        if (event.detail.name) setNames(current => ({ ...current, [event.detail.peerId]: event.detail.name! }));
      });
      s.addEventListener('peer-left', (event) => {
        setRemotePresence((current) => {
          const next = { ...current };
          delete next[event.detail.peerId];
          return next;
        });
        setRemoteRecording((r) => {
          const next = { ...r };
          delete next[event.detail.peerId];
          return next;
        });
        e.removePeer(event.detail.peerId);
        setPeers((p) => {
          const copy = { ...p };
          delete copy[event.detail.peerId];
          return copy;
        });
      });
      s.addEventListener('presence', (event) => {
        const p = event.detail.payload as {
          name?: string;
          recording?: boolean;
          muted?: boolean;
          deafened?: boolean;
          microphone?: boolean;
        };
        setRemotePresence((current) => ({ ...current, [event.detail.peerId]: {
          muted: typeof p?.muted === 'boolean' ? p.muted : p?.microphone === false,
          deafened: Boolean(p?.deafened),
        } }));
        setRemoteRecording((r) => ({
          ...r,
          [event.detail.peerId]: Boolean(p?.recording),
        }));
        if (p?.name)
          setNames((n) => ({ ...n, [event.detail.peerId]: p.name! }));
      });
      s.addEventListener('close', () => {
        if (engine.current === e) {
          callMicrophone.stop();
          void finishRecording();
          e.dispose();
          disposeCallPlayback();
          engine.current = null;
          setJoined(false);
          setCallPlaybackDeafened(false);
          setServerRtt(null);
          setStats([]);
          setRemote([]);
          setLocals(new Map());
          setPeers({});
          onError('Call disconnected. Join again to reconnect.');
        }
      });
      try {
        await e.captureUserMedia({
          camera: false,
          ...microphoneCaptureOptions(localStorage.getItem('bc-input') ?? ''),
        });
        await s.connect();
        setJoined(true);
        const input = callMicrophone.getSnapshot();
        s.sendPresence({ camera: false, microphone: !input.muted, sharing: false, muted: input.muted, deafened: input.deafened, name: user.name });
      } catch (error) {
        callMicrophone.stop();
        s.close();
        e.dispose();
        disposeCallPlayback();
        engine.current = null;
        socket.current = null;
        throw error;
      }
    });
    if (!engine.current) disposeCallPlayback();
  }
  async function screen() {
    if (!engine.current) {
      onError('Join the call before sharing your screen.');
      return;
    }
    if (locals.has('screen')) {
      await perform(async () => {
        if (engine.current!.isNativeScreenActive())
          await engine.current!.stopNativeScreen();
        else {
          await engine.current!.setLocalTrack('screen', null);
          await engine.current!.setLocalTrack('system', null);
        }
      });
    } else if (isTauri()) {
      const request = ++shareRequest.current;
      const originatingEngine = engine.current;
      onRequestShare({
        onShare: (options) => originatingEngine.captureNativeScreen(options),
        onBrowser: async () => {
          await originatingEngine.captureScreen(
            // Capture constraints follow the configured stream quality.
            { systemAudio: true },
            () =>
              request === shareRequest.current &&
              originatingEngine === engine.current,
          );
        },
        onClose: () => {
          if (request !== shareRequest.current) return;
          shareRequest.current++;
          void originatingEngine.stopNativeScreen();
        },
      });
    } else await browserScreen();
  }
  async function browserScreen() {
    await perform(async () => {
      if (!engine.current) return;
      // Capture constraints follow the configured stream quality.
      await engine.current.captureScreen({ systemAudio: true });
    });
  }
  async function camera() {
    await perform(async () => {
      if (!engine.current) {
        onError('Join the call to turn on your camera.');
        return;
      }
      if (locals.has('camera'))
        await engine.current.setLocalTrack('camera', null);
      else {
        await allowDesktopCapture('camera');
        await engine.current.captureUserMedia({
          camera: cameraCaptureConstraints(
            localStorage.getItem('bc-camera') ?? '',
            readCameraSettings(),
          ),
          microphone: false,
        });
      }
    });
  }
  function mic() {
    if (engine.current) callMicrophone.toggleMute();
    else onError('Join a call to use your microphone.');
  }
  function toggleDeafen() {
    callMicrophone.toggleDeafen();
    setCallPlaybackDeafened(callMicrophone.getSnapshot().deafened);
  }
  async function toggleRecord() {
    await perform(async () => {
      if (recorder.current) {
        await finishRecording();
      } else if (engine.current && user) {
        recordedTracks.current.clear();
        const metadata = {
          title: room?.name ?? 'Call recording',
          labels: { ...names, [user.id]: user.name },
        };
        recordingMetadata.current = metadata;
        const r = new TrackRecordingSession({
          ...readRecordingQuality(),
          onAutoStop: (result) => {
            void archiveRecording(result, metadata);
            setRecording(false);
            recorder.current = null;
            recordedTracks.current.clear();
            onError(
              'Recording reached its 512 MB limit and stopped. Saving the retained tracks to your library.',
            );
          },
          onError: (error) => onError(error.message),
        });
        r.start(
          [...engine.current.getLocalTracks()]
            .map(([source, track]) => ({ peerId: user.id, source, track }))
            .concat(
              engine.current.getRemoteTracks().map((t) => ({
                peerId: t.peerId,
                source: t.source,
                track: t.track,
              })),
            ),
        );
        recorder.current = r;
        setRecording(true);
        setResult(null);
      } else onError('Join the call before recording.');
    });
  }
  const shares = [
    ...(locals.has('screen')
      ? [{ id: 'local', name: 'Your screen', track: locals.get('screen')!, reencoded: false }]
      : []),
    ...remote
      .filter((t) => t.source === 'screen')
      .map((t) => ({
        id: t.peerId,
        name: (names[t.peerId] ?? 'Friend') + '’s screen',
        track: t.track,
        // The sender's direct native connection failed and it is re-encoding
        // its own decoded preview. Say so instead of looking like a bad share.
        reencoded: t.screenTransport === 'native-compatibility',
      })),
  ];
  const connected = Object.entries(peers).filter(
    ([id, state]) => state === 'connected' || stats.some(s => s.peerId === id && s.voiceRelay?.state === 'relayed'),
  ).length;
  const cameraParticipants = [
    { id: 'self', name: user?.name ?? 'You', track: locals.get('camera'), self: true },
    ...Object.keys(peers).map(id => ({
      id,
      name: names[id] ?? 'Friend',
      track: remote.find(t => t.peerId === id && t.source === 'camera')?.track,
      self: false,
    })),
  ];
  const shareSignature = shares.map(({ id, track }) => `${id}:${track.id}`).join('|');
  useEffect(() => {
    const available = new Set(shares.map(({ id }) => id));
    setWatchedShareIds(current => {
      const next = current.filter(id => available.has(id));
      if (available.has('local') && !next.includes('local')) next.unshift('local');
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
    setFocusedStageKey(current => {
      if (!current?.startsWith('screen:')) return current;
      return available.has(current.slice('screen:'.length)) ? current : null;
    });
  }, [shareSignature]);
  const availableStageItems: StageItem[] = [
    ...shares.map(share => ({
      key: `screen:${share.id}`,
      kind: 'screen' as const,
      name: share.name,
      track: share.track,
      self: share.id === 'local',
      reencoded: share.reencoded ?? false,
    })),
    ...cameraParticipants
      .filter((camera): camera is typeof camera & { track: MediaStreamTrack } => Boolean(camera.track))
      .map(camera => ({
        key: `camera:${camera.id}`,
        kind: 'camera' as const,
        name: camera.self ? 'Your camera' : camera.name,
        track: camera.track,
        self: camera.self,
      })),
  ];
  const focusedStageItem = availableStageItems.find(item => item.key === focusedStageKey);
  const watchedScreens = availableStageItems.filter(item =>
    item.kind === 'screen' && watchedShareIds.includes(item.key.slice('screen:'.length)),
  );
  const unifiedGrid = galleryLayout === 'all' && !focusedStageItem;
  const stageItems = focusedStageItem ? [focusedStageItem] : unifiedGrid ? [] : watchedScreens;
  const hasStageContent = stageItems.length > 0;
  const visibleTileCount = cameraParticipants.length + shares.length;
  const toggleWatchedShare = (id: string) => {
    setWatchedShareIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
    if (focusedStageKey === `screen:${id}`) setFocusedStageKey(null);
  };
  const focusShare = (id: string) => {
    setWatchedShareIds(current => current.includes(id) ? current : [...current, id]);
    setFocusedStageKey(`screen:${id}`);
  };
  const activeSpeakerCamera = cameraParticipants.find(camera => speaking.has(camera.id))?.id;
  const activeFeaturedCamera = galleryLayout === 'adaptive' && activeSpeakerCamera
    ? activeSpeakerCamera
    : cameraParticipants.some(camera => camera.id === featuredCamera)
      ? featuredCamera
      : cameraParticipants[0]?.id;
  const changeGalleryLayout = (value: GalleryLayout) => {
    setGalleryLayout(value);
    if (value === 'all') setFocusedStageKey(null);
    try { localStorage.setItem('bc-gallery-layout', value); } catch { /* Session-only when storage is unavailable. */ }
  };
  const toggleGalleryFit = () => {
    const next = galleryFit === 'cover' ? 'contain' : 'cover';
    setGalleryFit(next);
    try { localStorage.setItem('bc-gallery-fit', next); } catch { /* Session-only when storage is unavailable. */ }
  };
  if (!joined) {
    const lobbyPresence = callPresence.filter((presence) => presence.user_id !== user?.id);
    const existingSelf = callPresence.find((presence) => presence.user_id === user?.id);
    return (
      <>
      <section className="call-lobby" aria-label="Call lobby">
        <div className="call-lobby__hero">
          <span className="call-lobby__eyebrow">Ready to join</span>
          <h2>{(room as (Room & { display_name?: string }) | null)?.display_name || room?.name || (user ? 'Choose a room' : 'Your call')}</h2>
          <p>{room ? 'Review who is here, then join with your selected microphone. Your camera stays off until you enable it.' : 'Select a room or direct conversation to see its call and join.'}</p>
          {existingSelf && user && room ? <div className="call-lobby__device-choice">
            <strong aria-live="polite">You’re already in this call{existingSelf.device_count > 1 ? ` on ${existingSelf.device_count} devices` : ' on another device'}.</strong>
            <p>Reconnect here to move the call to this device, or keep the other device connected and add this one.</p>
            <div>
              <Button onClick={() => join('replace')} disabled={busy}><Headphones size={18} /> {busy ? 'Connecting…' : 'Reconnect from here'}</Button>
              <Button variant="secondary" onClick={() => join('additional')} disabled={busy}><Plus size={18} /> Connect second device</Button>
            </div>
            <small>Mute or deafen one device if its speakers can feed the other device’s microphone.</small>
          </div> : <Button onClick={() => join('replace')} disabled={busy || Boolean(user && !room)}>
            <Headphones size={18} /> {busy ? 'Connecting…' : !user ? 'Sign in to join' : room ? 'Join call' : 'Select a room to join'}
          </Button>}
        </div>
        <div className="call-lobby__roster">
          <h3>In this call</h3>
          {!user ? <p>Sign in to see who’s here.</p> : !room ? <p>Select a room to see its call roster.</p> : !presenceKnown ? <p role="status">Checking who’s here…</p> : lobbyPresence.length === 0 ? (
            <p>No one has joined yet. You can be the first.</p>
          ) : (
            <ul>{lobbyPresence.map((presence) => (
              <li key={presence.user_id}>
                <span className="avatar">{(presence.name || names[presence.user_id] || 'Friend').slice(0, 2).toUpperCase()}</span>
                <strong>{presence.name || names[presence.user_id] || 'Friend'}</strong>
                <span className="call-lobby__badges">
                  {presence.muted && <span><MicOff size={14} /> Muted</span>}
                  {presence.deafened && <span><Headphones size={14} /> Deafened</span>}
                  {presence.device_count > 1 && <span>{presence.device_count} devices</span>}
                </span>
              </li>
            ))}</ul>
          )}
        </div>
      </section>
      {result && (
        <div className="recording-downloads">
          <strong><Download size={16} /> Your recording</strong>
          <span>{saveStatus}</span>
          <Button variant="secondary" onClick={onRecordings}>Open recordings & player</Button>
          <details>
            <summary>Download original tracks</summary>
            {result.files.map((file) => <RecordingDownload key={file.name} file={file} />)}
          </details>
        </div>
      )}
      </>
    );
  }
  return (
    <div className="call-workspace" ref={workspace} data-controls-visible={!fullscreen || controlsVisible} onPointerMove={pointerActivity} onKeyDown={() => revealControls()}>
      <div className="call-layout-toolbar">
              {(recording || Object.values(remoteRecording).some(Boolean)) && (
                <span className="recording-badge">
                  <Circle size={9} fill="currentColor" />{' '}
                  {recording
                    ? 'RECORDING'
                    : Object.entries(remoteRecording)
                        .filter(([, value]) => value)
                        .map(([id]) => names[id] ?? 'Friend')
                        .join(', ') + ' IS RECORDING'}
                </span>
              )}
        <div className="gallery-layout-tools" role="group" aria-label="Call layout controls">
          <label>View <select aria-label="Call layout" value={galleryLayout} onChange={e => changeGalleryLayout(e.target.value as GalleryLayout)}>
            <option value="adaptive">Adaptive</option><option value="grid">Equal cameras</option><option value="focus">Focus camera</option><option value="all">Everyone + screens</option>
          </select></label>
          {!hasStageContent && <button onClick={toggleGalleryFit} aria-pressed={galleryFit === 'contain'}>{galleryFit === 'cover' ? 'Fill tiles' : 'Fit video'}</button>}
        </div>
        {hasStageContent && <>
          <label>Camera position <select aria-label="Camera position" value={docking.dock} onChange={e => docking.setDock(e.target.value as 'top' | 'left' | 'right')}>
            <option value="top">Top row</option><option value="left">Left side</option><option value="right">Right side</option>
          </select></label>
          {galleryLayout === 'all' && focusedStageItem && (
            <button onClick={() => setFocusedStageKey(null)}><LayoutGrid size={15} /> Back to all media</button>
          )}
          {focusedStageItem && watchedScreens.length > 1 && (
            <button onClick={() => setFocusedStageKey(null)}><LayoutGrid size={15} /> Show {watchedScreens.length} screens</button>
          )}
          <button onClick={docking.reset}>Reset layout</button>
        </>}
        <CameraOverlay cameras={[
          ...(locals.get('camera') ? [{ id: 'self', name: 'You', track: locals.get('camera')!, speaking: speaking.has('self'), muted, deafened }] : []),
          ...remote.filter(track => track.source === 'camera').map(track => ({ id: track.peerId, name: names[track.peerId] ?? 'Friend', track: track.track, speaking: speaking.has(track.peerId), muted: remotePresence[track.peerId]?.muted, deafened: remotePresence[track.peerId]?.deafened })),
        ]} />
        <button onClick={() => { if (document.fullscreenElement) void document.exitFullscreen().then(onInvite); else onInvite(); }} aria-label="Invite to call"><Plus size={16} /> Invite</button>
        <button onClick={onFocus} aria-pressed={focused}>{focused ? 'Show navigation' : 'Focus call'}</button>
        <button onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen call' : 'Fullscreen call'}><Maximize2 size={16} /></button>
      </div>
      <div ref={docking.stage} data-joined={joined} className="stage" data-dock={docking.dock} data-has-share={hasStageContent} data-content-count={stageItems.length} data-gallery={galleryLayout} data-camera-fit={galleryFit} data-camera-count={visibleTileCount} style={{ '--camera-size': docking.size + 'px' } as CSSProperties}>
        <div className="camera-dock">
          <button className="camera-dock-handle" aria-label="Drag cameras to dock" {...docking.moveHandlers}>⠿ Cameras · drag to dock</button>
          <div className="camera-strip">
          <div
            className={`camera-tile self${speaking.has('self') ? ' is-speaking' : ''}${activeFeaturedCamera === 'self' ? ' is-featured' : ''}`}
            data-speaking={speaking.has('self')}
            style={{ '--media-aspect': cameraAspects.self ?? 16 / 9 } as CSSProperties}
          >
            {locals.has('camera') && (cameraParticipants.length > 1 || shares.length > 0) && <button className="camera-focus-button" aria-label={hasStageContent || shares.length ? 'Put your camera on stage' : 'Focus You'} aria-pressed={focusedStageKey === 'camera:self' || (!hasStageContent && galleryLayout === 'focus' && activeFeaturedCamera === 'self')} onClick={() => {
              if (hasStageContent || shares.length) setFocusedStageKey('camera:self');
              else { setFeaturedCamera('self'); changeGalleryLayout('focus'); }
            }}><Pin size={14} /></button>}
            {speaking.has('self') && (
              <span className="speaking-label">Microphone active</span>
            )}
            {locals.has('camera') ? (
              <TrackVideo track={locals.get('camera')!} self onAspectRatio={ratio => setCameraAspects(current => current.self === ratio ? current : { ...current, self: ratio })} />
            ) : (
              <span className="avatar avatar-large">
                {(user?.name ?? 'You').slice(0, 2).toUpperCase()}
              </span>
            )}
            <div className="tile-caption">
              <span>
                {user?.name ?? 'You'} {joined ? '· you' : ''}
              </span>
              {muted ? <MicOff size={13} /> : <Mic size={13} />}
              {deafened && <Headphones size={13} aria-label="Deafened" />}
            </div>
          </div>
          {Object.keys(peers).map((id) => (
            <div
              className={`camera-tile${speaking.has(id) ? ' is-speaking' : ''}${activeFeaturedCamera === id ? ' is-featured' : ''}`}
              key={id}
              data-speaking={speaking.has(id)}
              style={{ '--media-aspect': cameraAspects[id] ?? 16 / 9 } as CSSProperties}
            >
              {remote.some((track) => track.peerId === id && track.source === 'camera') && (cameraParticipants.length > 1 || shares.length > 0) && <button className="camera-focus-button" aria-label={hasStageContent || shares.length ? `Put ${names[id] ?? 'Friend'} on stage` : `Focus ${names[id] ?? 'Friend'}`} aria-pressed={focusedStageKey === `camera:${id}` || (!hasStageContent && galleryLayout === 'focus' && activeFeaturedCamera === id)} onClick={() => {
                if (hasStageContent || shares.length) setFocusedStageKey(`camera:${id}`);
                else { setFeaturedCamera(id); changeGalleryLayout('focus'); }
              }}><Pin size={14} /></button>}
              {speaking.has(id) && (
                <span className="speaking-label">Speaking</span>
              )}
              {remote.find((t) => t.peerId === id && t.source === 'camera') ? (
                <TrackVideo
                  track={
                    remote.find(
                      (t) => t.peerId === id && t.source === 'camera',
                    )!.track
                  }
                  onAspectRatio={ratio => setCameraAspects(current => current[id] === ratio ? current : { ...current, [id]: ratio })}
                />
              ) : (
                <span className="avatar avatar-large">
                  {(names[id] ?? 'Friend').slice(0, 2).toUpperCase()}
                </span>
              )}
              <div className="tile-caption">
                <span>{names[id] ?? 'Friend'}</span>
                {remotePresence[id]?.muted && <MicOff size={13} aria-label="Muted" />}
                {remotePresence[id]?.deafened && <Headphones size={13} aria-label="Deafened" />}
                <span
                  className={
                    peers[id] === 'connected' || stats.some(s => s.peerId === id && s.voiceRelay?.state === 'relayed') ? 'online-dot' : 'connecting-dot'
                  }
                />
              </div>
              <details className="peer-volume">
                <summary aria-label="Adjust participant volume">
                  <Volume2 size={14} />
                </summary>
                <PeerVolume peerId={id} remote={remote} balanced={balanced} />
              </details>
            </div>
          ))}
          {shares.filter(screenShare => unifiedGrid || !watchedShareIds.includes(screenShare.id)).map((screenShare) => {
            const watching = watchedShareIds.includes(screenShare.id);
            return (
              <div className="camera-tile screen-share-tile" data-watching={watching} key={`screen-preview:${screenShare.id}`}>
                {watching ? <TrackVideo track={screenShare.track} /> : <FrozenTrackPreview track={screenShare.track} name={screenShare.name} />}
                <button className="camera-focus-button" aria-label={`Focus ${screenShare.name}`} aria-pressed={focusedStageKey === `screen:${screenShare.id}`} onClick={() => focusShare(screenShare.id)}><Pin size={14} /></button>
                <div className="screen-share-actions">
                  <button aria-label={`${watching ? 'Stop watching' : 'Watch'} ${screenShare.name}`} onClick={() => toggleWatchedShare(screenShare.id)}>
                    <MonitorUp size={14} /> {watching ? 'Stop watching' : 'Watch'}
                  </button>
                </div>
                <div className="tile-caption">
                  <span>{screenShare.name}</span>
                  {screenShare.reencoded && (
                    <span
                      className="screen-share-degraded"
                      title="The direct native connection failed, so this screen is being re-encoded through the call at reduced quality."
                    >
                      Reduced quality
                    </span>
                  )}
                  <MonitorUp size={13} />
                </div>
              </div>
            );
          })}
          </div>
        </div>
        {hasStageContent && <div className="camera-divider" role="separator" tabIndex={0} aria-label="Resize cameras" aria-orientation={docking.dock === 'top' ? 'horizontal' : 'vertical'} aria-valuemin={docking.minimum} aria-valuemax={docking.maximum} aria-valuenow={Math.round(docking.size)} {...docking.resizeHandlers} onKeyDown={docking.resizeKey} />}
        {docking.target && <div className="dock-targets" aria-hidden="true"><span data-active={docking.target === 'left'}>Left</span><span data-active={docking.target === 'top'}>Top</span><span data-active={docking.target === 'right'}>Right</span></div>}
        {remote
          .filter((t) => t.track.kind === 'audio' && (t.source !== 'system' || watchedShareIds.includes(t.peerId)))
          .map((t) => (
            <RemoteAudio
              key={t.peerId + t.source + t.track.id}
              track={t.track}
              peerId={t.peerId}
              source={t.source}
              balanced={balanced}
            />
          ))}
        {audioBlocked && joined && (
          <Button
            variant="secondary"
            onClick={() => {
              window.dispatchEvent(new Event('bc-audio-unlock'));
              setAudioBlocked(false);
            }}
          >
            <Volume2 size={17} /> Enable call audio
          </Button>
        )}
        <div className={'content-stage ' + (hasStageContent ? 'has-share' : '')} data-content-fit={contentFit}>
          {hasStageContent ? (
            <>
              <div className="content-grid">
                {stageItems.map(item => (
                  <ZoomableStageItem
                    key={item.key}
                    item={item}
                    contentFit={contentFit}
                    canFocus={!focusedStageItem && stageItems.length > 1}
                    onFocus={() => setFocusedStageKey(item.key)}
                    onRemove={() => item.kind === 'screen'
                      ? toggleWatchedShare(item.key.slice('screen:'.length))
                      : setFocusedStageKey(null)}
                    onToggleFit={() => {
                      const next = contentFit === 'fit' ? 'fill' : 'fit';
                      setContentFit(next);
                      try { localStorage.setItem('bc-content-fit', next); } catch { /* Session-only when storage is unavailable. */ }
                    }}
                    onFullscreen={toggleFullscreen}
                  />
                ))}
              </div>
              <span className="content-security"><ShieldCheck size={14} /> {connected} connected · encrypted media</span>
            </>
          ) : (
            <div className="stage-empty">
              <div className="share-illustration">
                <div className="illustration-window"><span /><span /><span /><div className="illustration-content"><Radio size={39} /><div /><div /></div></div>
                <div className="floating-play"><MonitorUp size={24} /></div>
              </div>
              <h2>Big screen. Small circle.</h2>
              <p>Share your game, a movie night, or your next idea.<br /> Everyone gets the best seat in the room.</p>
              <Button onClick={screen} variant="secondary" disabled={busy}><MonitorUp size={17} /> Share your screen</Button>
            </div>
          )}
        </div>
      </div>
      <div className="call-footer">
        {talkSettings.enabled && (
          <span className="push-to-talk-status" role="status" title={globalMessage}>
            {globalStatus === 'unavailable' || globalStatus === 'connecting' ? globalMessage : deafened ? 'Deafened' : manualMuted ? 'Microphone muted' : !transmitting ? `Hold ${talkBindingLabel(talkSettings.binding)} to talk${globalStatus === 'active' ? ' · Global' : ''}` : 'Push-to-talk · Transmitting'}
          </span>
        )}
        <ConnectionStatus
          joined={joined}
          peerCount={Object.keys(peers).length}
          serverRtt={serverRtt}
          stats={stats}
          names={names}
          onDetails={() => setShowStats(!showStats)}
        />
        <div className="call-controls">
          <Button
            variant={muted ? 'danger' : 'secondary'}
            size="icon"
            aria-label={deafened ? 'Microphone muted while deafened' : manualMuted ? 'Unmute microphone' : 'Mute microphone'}
            onClick={mic}
            disabled={deafened}
          >
            {muted ? <MicOff size={19} /> : <Mic size={19} />}
          </Button>
          <Button
            variant={deafened ? 'danger' : 'secondary'}
            size="icon"
            aria-label={deafened ? 'Undeafen call' : 'Deafen call'}
            onClick={toggleDeafen}
          >
            <Headphones size={19} />
          </Button>
          <Button
            variant={locals.has('camera') ? 'default' : 'secondary'}
            size="icon"
            aria-label={
              locals.has('camera') ? 'Turn off camera' : 'Turn on camera'
            }
            onClick={camera}
            disabled={busy}
          >
            {locals.has('camera') ? (
              <Video size={19} />
            ) : (
              <VideoOff size={19} />
            )}
          </Button>
          {joined ? (
            <>
              <Button
                variant={locals.has('screen') ? 'default' : 'secondary'}
                size="icon"
                aria-label={
                  locals.has('screen') ? 'Stop sharing' : 'Share screen'
                }
                onClick={screen}
                disabled={busy}
              >
                <MonitorUp size={19} />
              </Button>
              <Button
                variant={recording ? 'danger' : 'secondary'}
                size="icon"
                aria-label={
                  recording ? 'Stop recording' : 'Record separate tracks'
                }
                onClick={toggleRecord}
                disabled={busy}
              >
                {recording ? <Square size={16} /> : <Circle size={17} />}
              </Button>
              <Button variant="danger" onClick={leave}>
                <PhoneOff size={18} /> Leave call
              </Button>
            </>
          ) : (
            <Button onClick={() => join('replace')} disabled={busy}>
              <Headphones size={18} />
              {busy ? 'Connecting…' : user ? 'Join call' : 'Sign in to join'}
            </Button>
          )}
        </div>
      </div>
      {showStats && (
        <div className="stats-panel">
          <strong>Connection details</strong>
          <Button variant="secondary" onClick={() => void downloadDiagnostics()}>Download diagnostic report</Button>
          <Button variant="secondary" onClick={() => {
            const report = {
              version: 1, time: new Date().toISOString(), serverRtt,
              playback: getCallPlaybackStatus(),
              microphoneSettings: readProcessingSettings(),
              speakingIndicatorThresholdDb: readSpeakingThreshold(),
              peers: stats.map(({ peerId: _peerId, voiceRelay, ...peer }, index) => ({
                peer: index + 1, ...peer,
                voiceRelay: voiceRelay ? { state: voiceRelay.state } : undefined,
              })),
              localSources: [...locals].map(([source, track]) => ({ source, enabled: track.enabled, muted: track.muted, readyState: track.readyState })),
              remoteSources: remote.map(({ source, track }) => ({ source, enabled: track.enabled, muted: track.muted, readyState: track.readyState })),
            };
            void navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(
              () => setReportStatus('Connection report copied. No audio, video, addresses, or credentials included.'),
              () => setReportStatus('Could not copy. Allow clipboard access and try again.'),
            );
          }}>Copy connection report</Button>
          {reportStatus && <small role="status">{reportStatus}</small>}
          {stats.length ? (
            stats.map((s) => (
              <div key={s.peerId}>
                <span>
                  {names[s.peerId] ?? 'Friend'} · {s.connectionState} ·{' '}
                  {s.route?.localCandidateType === 'relay' ||
                  s.route?.remoteCandidateType === 'relay'
                    ? 'Relay'
                    : s.route
                      ? 'Direct'
                      : 'Route pending'}{' '}
                  · {s.route?.currentRoundTripTimeMs?.toFixed(0) ?? '—'} ms RTT
                </span>
                {s.tracks.map((t, i) => (
                  <small key={i}>
                    {t.direction === 'outbound' ? 'Sending' : 'Receiving'}{' '}
                    {t.source ?? t.mediaKind}
                    {t.source === 'screen' && t.screenTransport
                      ? ` (${t.screenTransport === 'native-compatibility' ? 'native compatibility' : 'browser WebRTC'})`
                      : ''}: {(t.bitrate / 1000).toFixed(0)}{' '}
                    kbps{' '}
                    {t.width
                      ? `· ${t.width}×${t.height} · ${t.framesPerSecond ?? '—'} FPS`
                      : ''}
                  </small>
                ))}
                {s.nativeScreen && <small>Native screen: {s.nativeScreen.connectionState} · {s.nativeScreen.framesDecoded} decoded frames · {(s.nativeScreen.bytesReceived / 1024).toFixed(0)} KB received · {s.nativeScreen.codec ?? 'codec pending'}</small>}
              </div>
            ))
          ) : (
            <p>Media measurements appear when a friend connects.</p>
          )}
        </div>
      )}
      {result && <div className="recording-downloads call-recording-notice">
        <span>{saveStatus}</span>
        <button onClick={() => { if (document.fullscreenElement) void document.exitFullscreen().then(onRecordings); else onRecordings(); }}>Open recordings & player</button>
        <details><summary>Download original tracks</summary>{result.files.map(file => <RecordingDownload key={file.name} file={file} />)}</details>
      </div>}

    </div>
  );
}

function ZoomableStageItem({
  item,
  contentFit,
  canFocus,
  onFocus,
  onRemove,
  onToggleFit,
  onFullscreen,
}: {
  item: StageItem;
  contentFit: 'fit' | 'fill';
  canFocus: boolean;
  onFocus(): void;
  onRemove(): void;
  onToggleFit(): void;
  onFullscreen(): void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; x: number; y: number; px: number; py: number } | null>(null);
  useEffect(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setReceiving(false);
  }, [item.track]);
  const commitPan = (next: { x: number; y: number }) => {
    panRef.current = next;
    setPan(next);
  };
  const constrainPan = (next: { x: number; y: number }, scale: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect || scale <= 1) return { x: 0, y: 0 };
    const maxX = rect.width * (scale - 1) / 2;
    const maxY = rect.height * (scale - 1) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  };
  useEffect(() => {
    const target = viewport.current;
    if (!target || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      commitPan(constrainPan(panRef.current, zoomRef.current));
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const zoomAt = (requested: number, clientX?: number, clientY?: number) => {
    const next = Math.max(.5, Math.min(5, requested));
    const previous = zoomRef.current;
    if (Math.abs(next - previous) < .0001) return;
    const rect = viewport.current?.getBoundingClientRect();
    const point = rect && clientX !== undefined && clientY !== undefined
      ? { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }
      : { x: 0, y: 0 };
    const ratio = next / previous;
    commitPan(constrainPan({
      x: point.x - ratio * (point.x - panRef.current.x),
      y: point.y - ratio * (point.y - panRef.current.y),
    }, next));
    zoomRef.current = next;
    setZoom(next);
  };
  const wheelZoom = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    zoomAt(zoomRef.current * Math.exp(-pixels * .00125), event.clientX, event.clientY);
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (zoomRef.current <= 1 || event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, px: panRef.current.x, py: panRef.current.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
    setDragging(false);
  };
  const reset = () => {
    zoomRef.current = 1;
    setZoom(1);
    commitPan({ x: 0, y: 0 });
  };
  return (
    <section className="stage-content-pane" data-kind={item.kind} data-dragging={dragging} aria-label={item.name}>
      <div className="stage-topline">
        <span>{item.kind === 'screen' ? <MonitorUp size={15} /> : <Video size={15} />}{item.name.toUpperCase()}</span>
        <div className="stage-pane-actions">
          {canFocus && <button aria-label={`Focus ${item.name}`} onClick={onFocus}><Pin size={14} /> Focus</button>}
          {item.reencoded && (
            <span
              className="stage-badge stage-badge-degraded"
              title="The direct native connection failed, so this screen is being re-encoded through the call at reduced quality."
            >
              Reduced quality
            </span>
          )}
          <span className="stage-badge">{item.kind === 'camera' || receiving ? 'Live' : 'Waiting for video'}</span>
          <button aria-label={item.kind === 'screen' ? `Stop watching ${item.name}` : `Return ${item.name} to the camera row`} onClick={onRemove}><X size={15} /></button>
        </div>
      </div>
      <div
        ref={viewport}
        className="video-viewport"
        data-pannable={zoom > 1}
        onWheel={wheelZoom}
        onPointerDown={pointerDown}
        onPointerMove={(event) => {
          if (!drag.current || drag.current.pointerId !== event.pointerId) return;
          commitPan(constrainPan({ x: drag.current.px + event.clientX - drag.current.x, y: drag.current.py + event.clientY - drag.current.y }, zoomRef.current));
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div className="zoom-surface" style={{ transform: `translate3d(${pan.x}px,${pan.y}px,0) scale(${zoom})` }}>
          <TrackVideo track={item.track} self={item.kind === 'camera' && item.self} showStatus={item.kind === 'screen'} onReceiving={item.kind === 'screen' ? setReceiving : undefined} />
        </div>
      </div>
      <div className="stage-bottomline">
        <span>{zoom > 1 ? 'Drag to move · scroll to zoom' : 'Scroll or pinch to zoom'}</span>
        <div>
          <button aria-label={`Zoom out ${item.name}`} onClick={() => zoomAt(zoomRef.current - .1)}><ZoomOut size={16} /></button>
          <button onClick={reset} aria-label={`Reset zoom ${item.name}`}>{Math.round(zoom * 100)}%</button>
          <button aria-label={contentFit === 'fit' ? 'Fill available space' : 'Fit entire shared screen'} onClick={() => { onToggleFit(); reset(); }}>{contentFit === 'fit' ? 'Fit' : 'Fill'}</button>
          <button aria-label={`Zoom in ${item.name}`} onClick={() => zoomAt(zoomRef.current + .1)}><ZoomIn size={16} /></button>
          <span />
          <button aria-label="Fullscreen shared content" onClick={onFullscreen}><Maximize2 size={16} /></button>
        </div>
      </div>
    </section>
  );
}

function FrozenTrackPreview({ track, name }: { track: MediaStreamTrack; name: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    const source = video.current;
    const target = canvas.current;
    if (!source || !target) return;
    let active = true;
    let captured = false;
    let frameRequest: number | undefined;
    const fallbackTimer = window.setTimeout(() => {
      if (active && !captured) setStatus('unavailable');
    }, 8_000);
    const capture = () => {
      if (!active || captured || !source.videoWidth || !source.videoHeight) return;
      captured = true;
      const scale = Math.min(1, 720 / source.videoWidth, 405 / source.videoHeight);
      target.width = Math.max(1, Math.round(source.videoWidth * scale));
      target.height = Math.max(1, Math.round(source.videoHeight * scale));
      target.getContext('2d', { alpha: false })?.drawImage(source, 0, 0, target.width, target.height);
      // The track keeps arriving whether or not this tile paints it, so freezing
      // the picture must not tear the decoder down. A detached decoder needs a
      // keyframe when watching resumes, and a native sender cannot supply one on
      // request, which stalls the resumed view until the next scheduled IDR.
      // Keep decoding into the offscreen element and show the still frame.
      setStatus('ready');
    };
    const queueCapture = () => {
      if (source.requestVideoFrameCallback) frameRequest = source.requestVideoFrameCallback(capture);
      else window.setTimeout(capture, 0);
    };
    source.srcObject = new MediaStream([track]);
    source.addEventListener('loadeddata', queueCapture, { once: true });
    void source.play().catch(() => { if (active) setStatus('unavailable'); });
    return () => {
      active = false;
      clearTimeout(fallbackTimer);
      if (frameRequest !== undefined && source.cancelVideoFrameCallback) source.cancelVideoFrameCallback(frameRequest);
      source.removeEventListener('loadeddata', queueCapture);
      source.pause();
      source.srcObject = null;
    };
  }, [track]);

  return (
    <div className="frozen-track-preview" data-preview-ready={status === 'ready'}>
      <canvas ref={canvas} aria-label={`Preview of ${name}`} />
      {status === 'loading' && <span>Preparing preview…</span>}
      {status === 'unavailable' && <span>Preview unavailable</span>}
      <video ref={video} muted playsInline aria-hidden="true" />
    </div>
  );
}

function createCallPeerId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function TrackVideo({
  track,
  self = false,
  showStatus = false,
  onReceiving,
  onAspectRatio,
}: {
  track: MediaStreamTrack;
  self?: boolean;
  showStatus?: boolean;
  onReceiving?: (receiving: boolean) => void;
  onAspectRatio?: (ratio: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const receivingCallback = useRef(onReceiving);
  receivingCallback.current = onReceiving;
  const aspectCallback = useRef(onAspectRatio);
  aspectCallback.current = onAspectRatio;
  const [videoStatus, setVideoStatus] = useState('Waiting for video frames…');
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let active = true;
    setVideoStatus('Waiting for video frames…');
    receivingCallback.current?.(false);
    video.srcObject = new MediaStream([track]);
    const metadata = () => {
      if (video.videoWidth && video.videoHeight)
        aspectCallback.current?.(Math.max(.4, Math.min(2.4, video.videoWidth / video.videoHeight)));
    };
    video.addEventListener('loadedmetadata', metadata);
    video.addEventListener('resize', metadata);
    void video.play().catch(() => { if (active) setVideoStatus('Video playback needs another attempt.'); });
    const started = performance.now();
    let lastFrame = 0, lastProgress = started;
    const check = showStatus ? setInterval(() => {
      const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? (video.readyState >= 2 ? 1 : 0);
      if (frames > lastFrame) {
        lastFrame = frames; lastProgress = performance.now(); setVideoStatus('');
        receivingCallback.current?.(true);
      } else if (performance.now() - lastProgress > 12_000) {
        setVideoStatus(lastFrame ? 'Screen video has stopped arriving. Ask the sender to restart sharing.' : 'No video frames have arrived. Ask the sender to restart or try browser sharing.');
        receivingCallback.current?.(false);
      }
    }, 1000) : undefined;
    return () => {
      active = false;
      clearInterval(check);
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('resize', metadata);
      video.srcObject = null;
    };
  }, [track, showStatus]);
  return (
    <>
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={self ? 'self-video' : ''}
    />
    {showStatus && videoStatus && <div role="status" style={{ position: 'absolute', left: 16, right: 16, bottom: 16, display: 'grid', placeContent: 'center', gap: 12, padding: 16, borderRadius: 12, textAlign: 'center', background: '#101414e6' }}>
      <span>{videoStatus}</span>
      <Button variant="secondary" onClick={() => {
        void ref.current?.play().catch(() => setVideoStatus('Could not start video playback. Check connection details below.'));
      }}>Retry playback</Button>
    </div>}
    </>
  );
}
function PeerVolume({
  peerId,
  remote,
  balanced,
}: {
  peerId: string;
  remote: RemoteTrack[];
  balanced: boolean;
}) {
  const [volume, setVolume] = useState(
    readParticipantVolume(peerId),
  );
  return (
    <label>
      Volume {Math.round(volume * 100)}%
      <input
        aria-label="Participant volume"
        type="range"
        min="0"
        max="2"
        step="0.05"
        value={volume}
        onChange={(e) => {
          const v = Number(e.target.value);
          setVolume(v);
          localStorage.setItem('bc-volume-' + peerId, String(v));
          window.dispatchEvent(
            new CustomEvent('bc-volume', { detail: { peerId, volume: v } }),
          );
        }}
      />
      <small>
        {balanced
          ? 'Voice balancing on'
          : `${remote.filter((t) => t.peerId === peerId).length} media tracks`}
      </small>
    </label>
  );
}
function RemoteAudio({
  track,
  peerId,
  source,
  balanced,
}: {
  track: MediaStreamTrack;
  peerId: string;
  source: MediaSourceKind;
  balanced: boolean;
}) {
  useEffect(() => {
    return attachRemoteAudio({
      track,
      peerId,
      balanceVoice: balanced && source === 'microphone',
    });
  }, [track, peerId, source, balanced]);
  return null;
}
