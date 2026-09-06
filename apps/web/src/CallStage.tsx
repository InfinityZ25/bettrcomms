import { useEffect, useRef, useState, type PointerEvent } from 'react';
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
import { microphoneCaptureOptions } from './media/processingSettings';
import {
  cameraCaptureConstraints,
  readCameraSettings,
} from './media/cameraSettings';
import { readQuality } from './MediaSettings';
import type { PeerMediaStats } from './media';
import { isTauri } from '@tauri-apps/api/core';
import type { NativeScreenStartOptions } from './media/nativeScreen';

export interface NativeShareActions {
  onShare(options: NativeScreenStartOptions): Promise<void>;
  onBrowser(): Promise<void>;
  onClose(): void;
}

export default function CallStage({
  user,
  room,
  layout,
  noise,
  balanced,
  onError,
  onInvite,
  onRecordings,
  onRequestShare,
}: {
  user: User | null;
  room: Room | null;
  layout: string;
  noise: boolean;
  balanced: boolean;
  onError: (s: string) => void;
  onInvite: () => void;
  onRecordings: () => void;
  onRequestShare: (actions: NativeShareActions) => void;
}) {
  const [joined, setJoined] = useState(false),
    [busy, setBusy] = useState(false),
    [locals, setLocals] = useState<Map<MediaSourceKind, MediaStreamTrack>>(
      new Map(),
    ),
    [remote, setRemote] = useState<RemoteTrack[]>([]),
    [peers, setPeers] = useState<Record<string, string>>({}),
    [names, setNames] = useState<Record<string, string>>({}),
    [muted, setMuted] = useState(false),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [recording, setRecording] = useState(false),
    [result, setResult] = useState<RecordingResult | null>(null),
    [selected, setSelected] = useState(''),
    [cameraHeight, setCameraHeight] = useState(
      Math.max(
        72,
        Math.min(
          220,
          Number(
            localStorage.getItem('bc-camera-height') ??
              (window.innerHeight < 800 ? 100 : 134),
          ),
        ),
      ),
    );
  const engine = useRef<MediaEngine | null>(null),
    socket = useRef<RoomWebSocketSignaling | null>(null),
    recorder = useRef<TrackRecordingSession | null>(null),
    drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
      null,
    ),
    shareRequest = useRef(0),
    active = useRef(true);
  const [stats, setStats] = useState<PeerMediaStats[]>([]),
    [showStats, setShowStats] = useState(false),
    [remoteRecording, setRemoteRecording] = useState<Record<string, boolean>>(
      {},
    ),
    [audioBlocked, setAudioBlocked] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [serverRtt, setServerRtt] = useState<number | null>(null);
  const [reportStatus, setReportStatus] = useState('');
  const [receivingVideo, setReceivingVideo] = useState<string | null>(null);
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
    setMuted(false);
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
        const wasEnabled =
          e.getLocalTracks().get('microphone')?.enabled ?? true;
        await e.captureUserMedia({
          camera: false,
          ...microphoneCaptureOptions(localStorage.getItem('bc-input') ?? ''),
        });
        const track = e.getLocalTracks().get('microphone');
        if (track) track.enabled = wasEnabled;
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
        });
      } catch {}
  }, [joined, locals, muted, recording, Object.keys(peers).join(',')]);
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
          setNames(
            Object.fromEntries(r.members.map((m) => [m.user.id, m.user.name])),
          );
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
        const mic = e.getLocalTracks().get('microphone');
        if (mic) mic.enabled = !muted;
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
  async function join() {
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
      const s = new RoomWebSocketSignaling(
        user.id,
        '/api/v1/rooms/' + room.id + '/ws',
      );
      const e = new MediaEngine({
        signaling: s,
        voiceRelay: {
          url: `/api/v1/rooms/${room.id}/voice-relay`,
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
      });
      s.addEventListener('signal', (event) => {
        void e
          .handleSignal(event.detail)
          .catch((error) => onError(error.message));
      });
      s.addEventListener('peer-joined', (event) => {
        e.addPeer(event.detail.peerId);
        setPeers((p) => ({ ...p, [event.detail.peerId]: 'connecting' }));
      });
      s.addEventListener('peer-left', (event) => {
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
        };
        setRemoteRecording((r) => ({
          ...r,
          [event.detail.peerId]: Boolean(p?.recording),
        }));
        if (p?.name)
          setNames((n) => ({ ...n, [event.detail.peerId]: p.name! }));
      });
      s.addEventListener('close', () => {
        if (engine.current === e) {
          void finishRecording();
          e.dispose();
          disposeCallPlayback();
          engine.current = null;
          setJoined(false);
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
        setMuted(false);
        s.sendPresence({ camera: false, microphone: true, sharing: false });
      } catch (error) {
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
            {
              video: {
                width: { ideal: 2560 },
                height: { ideal: 1440 },
                frameRate: { ideal: 60, max: 60 },
              },
              systemAudio: true,
            },
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
      await engine.current.captureScreen({
        video: {
          width: { ideal: 2560 },
          height: { ideal: 1440 },
          frameRate: { ideal: 60, max: 60 },
        },
        systemAudio: true,
      });
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
    const track = engine.current?.getLocalTracks().get('microphone');
    if (track) {
      track.enabled = !track.enabled;
      setMuted(!track.enabled);
    } else onError('Join a call to use your microphone.');
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
      ? [{ id: 'local', name: 'Your screen', track: locals.get('screen')! }]
      : []),
    ...remote
      .filter((t) => t.source === 'screen')
      .map((t) => ({
        id: t.peerId,
        name: (names[t.peerId] ?? 'Friend') + '’s screen',
        track: t.track,
      })),
  ];
  const share = shares.find((s) => s.id === selected) ?? shares[0];
  const connected = Object.entries(peers).filter(
    ([id, state]) => state === 'connected' || stats.some(s => s.peerId === id && s.voiceRelay?.state === 'relayed'),
  ).length;
  function pointerDown(e: PointerEvent) {
    if (zoom <= 1) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  return (
    <>
      <div
        data-joined={joined}
        className={
          'stage ' +
          (layout === 'focus'
            ? 'focus-layout'
            : layout === 'side'
              ? 'side-layout'
              : '')
        }
      >
        <div
          className="camera-strip"
          style={layout === 'top' ? { height: cameraHeight } : undefined}
        >
          <div
            className={`camera-tile self${speaking.has('self') ? ' is-speaking' : ''}`}
            data-speaking={speaking.has('self')}
          >
            {speaking.has('self') && (
              <span className="speaking-label">Microphone active</span>
            )}
            {locals.has('camera') ? (
              <TrackVideo track={locals.get('camera')!} self />
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
            </div>
          </div>
          {Object.keys(peers).map((id) => (
            <div
              className={`camera-tile${speaking.has(id) ? ' is-speaking' : ''}`}
              key={id}
              data-speaking={speaking.has(id)}
            >
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
                />
              ) : (
                <span className="avatar avatar-large">
                  {(names[id] ?? 'Friend').slice(0, 2).toUpperCase()}
                </span>
              )}
              <div className="tile-caption">
                <span>{names[id] ?? 'Friend'}</span>
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
          <button className="camera-tile invite" onClick={onInvite}>
            <span className="invite-circle">
              <Plus size={22} />
            </span>
            <span>Bring someone along</span>
          </button>
        </div>
        {layout === 'top' && (
          <input
            className="camera-resize"
            aria-label="Camera row height"
            title="Resize camera row"
            type="range"
            min={72}
            max={220}
            step={4}
            value={cameraHeight}
            onChange={(e) => {
              setCameraHeight(Number(e.target.value));
              localStorage.setItem('bc-camera-height', e.target.value);
            }}
          />
        )}
        {remote
          .filter((t) => t.track.kind === 'audio')
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
        <div className={'content-stage ' + (share ? 'has-share' : '')}>
          <div className="stage-topline">
            <span>
              <MonitorUp size={15} />
              {share ? share.name.toUpperCase() : 'YOUR SHARED SPACE'}
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
            </span>
            {shares.length > 1 ? (
              <select
                aria-label="Select shared screen"
                value={share.id}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
              >
                {shares.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="stage-badge">
                {share
                  ? receivingVideo === share.track.id ? 'Live' : 'Waiting for video'
                  : joined
                    ? 'You’re in good company'
                    : 'Ready when you are'}
              </span>
            )}
          </div>
          {share ? (
            <div
              className="video-viewport"
              onWheel={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  setZoom((z) =>
                    Math.max(1, Math.min(5, z + (e.deltaY < 0 ? 0.1 : -0.1))),
                  );
                }
              }}
              onPointerDown={pointerDown}
              onPointerMove={(e) => {
                if (drag.current)
                  setPan({
                    x: drag.current.px + e.clientX - drag.current.x,
                    y: drag.current.py + e.clientY - drag.current.y,
                  });
              }}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
            >
              <div
                className="zoom-surface"
                style={{
                  transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
                }}
              >
                <TrackVideo track={share.track} showStatus onReceiving={receiving => setReceivingVideo(receiving ? share.track.id : null)} />
              </div>
            </div>
          ) : (
            <div className="stage-empty">
              <div className="share-illustration">
                <div className="illustration-window">
                  <span />
                  <span />
                  <span />
                  <div className="illustration-content">
                    <Radio size={39} />
                    <div />
                    <div />
                  </div>
                </div>
                <div className="floating-play">
                  <MonitorUp size={24} />
                </div>
              </div>
              <h2>Big screen. Small circle.</h2>
              <p>
                Share your game, a movie night, or your next idea.
                <br /> Everyone gets the best seat in the room.
              </p>
              <Button onClick={screen} variant="secondary" disabled={busy}>
                <MonitorUp size={17} /> Share your screen
              </Button>
            </div>
          )}
          <div className="stage-bottomline">
            <span>
              <ShieldCheck size={14} />
              {joined
                ? `${connected} connected · encrypted media`
                : 'Direct-first media'}
            </span>
            <div>
              <button
                aria-label="Zoom out"
                onClick={() => setZoom((z) => Math.max(1, z - 0.25))}
              >
                <ZoomOut size={16} />
              </button>
              <button
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
                aria-label="Reset zoom"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                aria-label="Zoom in"
                onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
              >
                <ZoomIn size={16} />
              </button>
              <span />
              <button
                aria-label="Fullscreen shared content"
                onClick={(e) => {
                  const target = e.currentTarget.closest('.content-stage');
                  if (document.fullscreenElement) document.exitFullscreen();
                  else
                    target
                      ?.requestFullscreen()
                      .catch((error) => onError(error.message));
                }}
              >
                <Maximize2 size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="call-footer">
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
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            onClick={mic}
          >
            {muted ? <MicOff size={19} /> : <Mic size={19} />}
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
            <Button onClick={join} disabled={busy}>
              <Headphones size={18} />
              {busy ? 'Connecting…' : user ? 'Join call' : 'Sign in to join'}
            </Button>
          )}
        </div>
      </div>
      {showStats && (
        <div className="stats-panel">
          <strong>Connection details</strong>
          <Button variant="secondary" onClick={() => {
            const report = {
              version: 1, time: new Date().toISOString(), serverRtt,
              playback: getCallPlaybackStatus(),
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
                    {t.source ?? t.mediaKind}: {(t.bitrate / 1000).toFixed(0)}{' '}
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
      {result && (
        <div className="recording-downloads">
          <strong>
            <Download size={16} /> Your recording
          </strong>
          <span>{saveStatus}</span>
          <Button variant="secondary" onClick={onRecordings}>
            Open recordings & player
          </Button>
          <details>
            <summary>Download original tracks</summary>
            {result.files.map((f) => (
              <RecordingDownload key={f.name} file={f} />
            ))}
          </details>
        </div>
      )}
    </>
  );
}
function TrackVideo({
  track,
  self = false,
  showStatus = false,
  onReceiving,
}: {
  track: MediaStreamTrack;
  self?: boolean;
  showStatus?: boolean;
  onReceiving?: (receiving: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const receivingCallback = useRef(onReceiving);
  receivingCallback.current = onReceiving;
  const [videoStatus, setVideoStatus] = useState('Waiting for video frames…');
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let active = true;
    setVideoStatus('Waiting for video frames…');
    receivingCallback.current?.(false);
    video.srcObject = new MediaStream([track]);
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
