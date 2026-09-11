import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  MediaEngine,
  RoomWebSocketSignaling,
  TrackRecordingSession,
  type MediaSourceKind,
  type PeerMediaStats,
  type RecordingResult,
  type RemoteTrack,
} from '@/media';
import { api, type Room, type User } from '@/api';
import { CallMicrophone } from '@/media/pushToTalk';
import { allowDesktopCapture } from '@/media/permissions';
import { cameraCaptureConstraints, readCameraSettings } from '@/media/cameraSettings';
import { microphoneCaptureOptions } from '@/media/processingSettings';
import { readRecordingQuality } from '@/media/recordingQuality';
import { saveRecording } from '@/media/recordingLibrary';
import {
  disposeCallPlayback,
  prepareCallPlayback,
  setCallPlaybackDeafened,
} from '@/media/remoteAudio';
import { useSpeakingActivity } from '@/media/useSpeakingActivity';
import { readQuality } from '@/features/settings/MediaSettings';
import { isTauri } from '@tauri-apps/api/core';
import { errorMessage } from '@/lib/errors';
import { readStored } from '@/lib/storage';
import { createCallPeerId } from './callPeerId';
import type { CallPresence, JoinMode, NativeShareActions } from './callTypes';

type PeerFlags = { muted: boolean; deafened: boolean };
type RecordingMetadata = { title: string; labels: Record<string, string> };

const captureOptions = () => microphoneCaptureOptions(readStored('bc-input') ?? '');
const cameraConstraints = () =>
  cameraCaptureConstraints(readStored('bc-camera') ?? '', readCameraSettings());

/**
 * Everything that makes a call a call: the media engine, the signaling socket,
 * the recorder, and the peer bookkeeping they produce. The call screen renders
 * what this returns and never touches the engine directly.
 */
export function useCallSession({
  user,
  room,
  noise,
  callPresence,
  onError,
  onRequestShare,
}: {
  user: User | null;
  room: Room | null;
  noise: boolean;
  callPresence: CallPresence[];
  onError: (message: string) => void;
  onRequestShare: (actions: NativeShareActions) => void;
}) {
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locals, setLocals] = useState<Map<MediaSourceKind, MediaStreamTrack>>(new Map());
  const [remote, setRemote] = useState<RemoteTrack[]>([]);
  const [peers, setPeers] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [saveStatus, setSaveStatus] = useState('');
  const [stats, setStats] = useState<PeerMediaStats[]>([]);
  const [serverRtt, setServerRtt] = useState<number | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [remotePresence, setRemotePresence] = useState<Record<string, PeerFlags>>({});
  const [remoteRecording, setRemoteRecording] = useState<Record<string, boolean>>({});
  /** Signaling is retrying. Media continues; setup and membership pause. */
  const [signalingDown, setSignalingDown] = useState(false);

  const engine = useRef<MediaEngine | null>(null);
  const socket = useRef<RoomWebSocketSignaling | null>(null);
  const recorder = useRef<TrackRecordingSession | null>(null);
  const shareRequest = useRef(0);
  const active = useRef(true);
  const recordedTracks = useRef(new Set<string>());
  const recordingMetadata = useRef<RecordingMetadata>({
    title: 'Call recording',
    labels: {},
  });

  const [callMicrophone] = useState(
    () => new CallMicrophone((enabled) => engine.current?.setMicrophoneEnabled(enabled)),
  );
  const microphoneState = useSyncExternalStore(
    callMicrophone.subscribe,
    callMicrophone.getSnapshot,
  );
  const { muted, deafened } = microphoneState;

  const peerIds = Object.keys(peers).join(',');
  /** A peer is audible once its connection is up or its voice is being relayed. */
  const isConnected = (id: string) =>
    peers[id] === 'connected' ||
    stats.some((peer) => peer.peerId === id && peer.voiceRelay?.state === 'relayed');

  const speaking = useSpeakingActivity(
    [
      ...(locals.get('microphone') && !muted
        ? [{ id: 'self', track: locals.get('microphone')! }]
        : []),
      ...remote
        .filter((track) => track.source === 'microphone' && isConnected(track.peerId))
        .map((track) => ({ id: track.peerId, track: track.track })),
    ],
    joined,
  );

  async function perform(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await task();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  const archiveRecording = async (
    finished: RecordingResult,
    metadata: RecordingMetadata,
  ) => {
    if (active.current) {
      setResult(finished);
      setSaveStatus('Saving recording…');
    }
    try {
      await saveRecording(finished, metadata);
      if (active.current) setSaveStatus('Saved to your recordings on this device.');
    } catch (error) {
      if (active.current) {
        setSaveStatus('Not saved. Download the original tracks below before closing.');
        onError(errorMessage(error));
      }
    }
  };

  const finishRecording = async () => {
    const current = recorder.current;
    const metadata = recordingMetadata.current;
    recorder.current = null;
    recordedTracks.current.clear();
    setRecording(false);
    if (!current) return;
    try {
      await archiveRecording(await current.stop(), metadata);
    } catch (error) {
      if (active.current) onError(errorMessage(error));
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
    setSignalingDown(false);
    setServerRtt(null);
    setStats([]);
    setLocals(new Map());
    setRemote([]);
    setPeers({});
    setRemoteRecording({});
    setRemotePresence({});
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
        .then((finished) => archiveRecording(finished, metadata))
        .catch(() => {});
      recorder.current = null;
    };
  }, []);

  // Signing in or out ends the call rather than carrying it across identities.
  //
  // A room change only reaches here when no call is live: CallSessionProvider
  // pins `room` to the room the call was joined in, so browsing elsewhere never
  // changes it mid-call. The guard keeps the release of that pin on hang-up — and
  // the first run on mount — from repeating a teardown that already ran.
  useEffect(() => {
    if (joined || engine.current || socket.current || recorder.current) leave();
  }, [room?.id, user?.id]);

  // Presence arriving over the app-wide stream seeds the roster, but once the
  // call is live its own signaling is authoritative for peers it already knows.
  useEffect(() => {
    const snapshot = Object.fromEntries(
      callPresence.map((presence) => [
        presence.user_id,
        { muted: presence.muted, deafened: presence.deafened },
      ]),
    );
    setRemotePresence((current) => {
      if (!joined) return snapshot;
      const merged = { ...current };
      for (const [peerId, value] of Object.entries(snapshot))
        if (!(peerId in merged)) merged[peerId] = value;
      return merged;
    });
  }, [callPresence, joined]);

  useEffect(() => {
    if (recorder.current) Object.assign(recordingMetadata.current.labels, names);
  }, [names]);

  useEffect(() => {
    if (!recording || !recorder.current || !user) return;
    const current = [...locals]
      .map(([source, track]) => ({ peerId: user.id, source, track }))
      .concat(
        remote.map((track) => ({
          peerId: track.peerId,
          source: track.source,
          track: track.track,
        })),
      );
    const ids = new Set(current.map((entry) => entry.track.id));
    for (const id of recordedTracks.current)
      if (!ids.has(id)) recorder.current.removeTrack(id);
    for (const entry of current) recorder.current.addTrack(entry);
    recordedTracks.current = ids;
  }, [locals, remote, recording, user?.id]);

  useEffect(() => {
    if (!joined) return;
    try {
      socket.current?.sendPresence({
        camera: locals.has('camera'),
        microphone: !muted,
        sharing: locals.has('screen'),
        recording,
        muted,
        deafened,
      });
    } catch {
      // The socket closed; the reconnection handler re-announces presence.
    }
  }, [joined, locals, muted, deafened, recording, peerIds]);

  // Room membership names every participant; signaling identities are keyed by
  // per-device peer IDs, so those entries survive a membership refresh.
  useEffect(() => {
    if (!room || !user) return;
    let live = true;
    api<{ members: { user: User }[] }>('/rooms/' + room.id + '/members')
      .then((response) => {
        if (live)
          setNames((current) => ({
            ...Object.fromEntries(
              response.members.map((member) => [member.user.id, member.user.name]),
            ),
            ...current,
          }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [room?.id, user?.id, peerIds]);

  useEffect(() => {
    if (!joined) return;
    let live = true;
    let pending = false;
    const poll = () => {
      const current = engine.current;
      if (!current || pending) return;
      pending = true;
      Promise.all(Object.keys(peers).map((id) => current.getStats(id).catch(() => null)))
        .then((results) => {
          if (live) setStats(results.filter((peer): peer is PeerMediaStats => peer !== null));
        })
        .finally(() => {
          pending = false;
        });
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [joined, peerIds]);

  // Re-capture the microphone whenever the processing chain changes underneath it.
  useEffect(() => {
    const update = async () => {
      if (!engine.current) return;
      try {
        await engine.current.captureUserMedia({ camera: false, ...captureOptions() });
      } catch (error) {
        onError(errorMessage(error));
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
    const handler = () => {
      engine.current?.setQuality(readQuality()).catch((error) => onError(error.message));
    };
    window.addEventListener('bc-quality', handler);
    return () => window.removeEventListener('bc-quality', handler);
  }, []);

  // A device change re-captures both sources at once, keeping the camera off if
  // it was off.
  useEffect(() => {
    const handler = async () => {
      const current = engine.current;
      if (!current) return;
      try {
        await current.captureUserMedia({
          ...captureOptions(),
          camera: current.getLocalTracks().has('camera') ? cameraConstraints() : false,
        });
      } catch (error) {
        onError(errorMessage(error));
      }
    };
    window.addEventListener('bc-devices', handler);
    return () => window.removeEventListener('bc-devices', handler);
  }, [noise, muted]);

  // Camera quality changes can arrive faster than a capture completes; each
  // request supersedes the last and only the newest one reports a failure.
  useEffect(() => {
    let current = 0;
    let pending = Promise.resolve();
    const handler = () => {
      const request = ++current;
      pending = pending.then(async () => {
        if (request !== current) return;
        const activeEngine = engine.current;
        if (!activeEngine?.getLocalTracks().has('camera')) return;
        try {
          await activeEngine.captureUserMedia({
            camera: cameraConstraints(),
            microphone: false,
          });
        } catch (error) {
          if (request === current) onError(errorMessage(error));
        }
      });
    };
    window.addEventListener('bc-camera-quality', handler);
    return () => {
      current += 1;
      window.removeEventListener('bc-camera-quality', handler);
    };
  }, [onError]);

  async function join(joinMode: JoinMode = 'replace') {
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
      const config = await api<{ ice_servers: RTCIceServer[] }>('/ice').catch(() =>
        api<{ ice_servers: RTCIceServer[] }>('/config'),
      );
      const peerId = createCallPeerId();
      const query = new URLSearchParams({ peer_id: peerId, join_mode: joinMode });
      const connection = new RoomWebSocketSignaling(
        peerId,
        `/api/v1/rooms/${room.id}/ws?${query}`,
      );
      const media = new MediaEngine({
        signaling: connection,
        voiceRelay: {
          url: `/api/v1/rooms/${room.id}/voice-relay?peer_id=${encodeURIComponent(peerId)}`,
          mode: readStored('bc-voice-route') === 'relay' ? 'relay' : 'automatic',
        },
        quality: readQuality(),
        ice: {
          mode: readStored('bc-direct') === 'true' ? 'direct-only' : 'direct-preferred',
          iceServers: config.ice_servers,
        },
      });
      engine.current = media;
      callMicrophone.start();
      socket.current = connection;

      connection.addEventListener('latency', (event) => {
        if (socket.current === connection) setServerRtt(event.detail.rttMs);
      });
      media.addEventListener('local-track', () => setLocals(new Map(media.getLocalTracks())));
      media.addEventListener('remote-track', () => setRemote(media.getRemoteTracks()));
      media.addEventListener('remote-track-removed', () => setRemote(media.getRemoteTracks()));
      media.addEventListener('peer-state', (event) =>
        setPeers((current) => ({ ...current, [event.detail.peerId]: event.detail.state })),
      );
      media.addEventListener('error', (event) =>
        onError('Media: ' + errorMessage(event.detail.error)),
      );
      media.addEventListener('denoiser-status', (event) => onError(event.detail.message));

      connection.addEventListener('peers', (event) => {
        for (const id of event.detail.peerIds) {
          media.addPeer(id);
          setPeers((current) =>
            current[id] === undefined ? { ...current, [id]: 'connecting' } : current,
          );
        }
        setNames((current) => {
          const next = { ...current };
          for (const [id, identity] of Object.entries(event.detail.identities))
            if (identity.name) next[id] = identity.name;
          return next;
        });
      });
      connection.addEventListener('signal', (event) => {
        void media.handleSignal(event.detail).catch((error) => onError(error.message));
      });
      connection.addEventListener('peer-joined', (event) => {
        const { peerId: id, name } = event.detail;
        media.addPeer(id);
        setPeers((current) =>
          current[id] === undefined ? { ...current, [id]: 'connecting' } : current,
        );
        if (name) setNames((current) => ({ ...current, [id]: name }));
      });
      connection.addEventListener('peer-left', (event) => {
        const { peerId: id } = event.detail;
        const without = <T,>(record: Record<string, T>) => {
          const next = { ...record };
          delete next[id];
          return next;
        };
        setRemotePresence(without);
        setRemoteRecording(without);
        media.removePeer(id);
        setPeers(without);
      });
      connection.addEventListener('presence', (event) => {
        const payload = event.detail.payload as {
          name?: string;
          recording?: boolean;
          muted?: boolean;
          deafened?: boolean;
          microphone?: boolean;
        };
        const id = event.detail.peerId;
        setRemotePresence((current) => ({
          ...current,
          [id]: {
            muted:
              typeof payload?.muted === 'boolean'
                ? payload.muted
                : payload?.microphone === false,
            deafened: Boolean(payload?.deafened),
          },
        }));
        setRemoteRecording((current) => ({ ...current, [id]: Boolean(payload?.recording) }));
        if (payload?.name) setNames((current) => ({ ...current, [id]: payload.name! }));
      });

      // Signaling carries setup and membership, not media. Established peer
      // connections keep flowing while the server restarts, so a dropped socket
      // is a degraded state, not the end of the call.
      connection.addEventListener('disconnected', () => {
        if (socket.current === connection) setSignalingDown(true);
      });
      connection.addEventListener('reconnected', () => {
        if (socket.current !== connection) return;
        setSignalingDown(false);
        // A restarted server has no memory of this participant's presence, and
        // peers it never saw join need connections. Both are re-announced by the
        // server's snapshot; adding a peer we already hold is a no-op.
        const input = callMicrophone.getSnapshot();
        const tracks = media.getLocalTracks();
        try {
          connection.sendPresence({
            camera: tracks.has('camera'),
            microphone: !input.muted,
            sharing: tracks.has('screen'),
            recording: recorder.current !== null,
            muted: input.muted,
            deafened: input.deafened,
            name: user.name,
          });
        } catch {
          // The socket closed again before presence could be re-announced;
          // the next reconnection repeats it.
        }
      });
      connection.addEventListener('close', () => {
        setSignalingDown(false);
        if (engine.current !== media) return;
        callMicrophone.stop();
        void finishRecording();
        media.dispose();
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
      });

      try {
        await media.captureUserMedia({ camera: false, ...captureOptions() });
        await connection.connect();
        setJoined(true);
        const input = callMicrophone.getSnapshot();
        connection.sendPresence({
          camera: false,
          microphone: !input.muted,
          sharing: false,
          muted: input.muted,
          deafened: input.deafened,
          name: user.name,
        });
      } catch (error) {
        callMicrophone.stop();
        connection.close();
        media.dispose();
        disposeCallPlayback();
        engine.current = null;
        socket.current = null;
        throw error;
      }
    });
    if (!engine.current) disposeCallPlayback();
  }

  async function toggleScreen() {
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
      return;
    }
    if (!isTauri()) {
      // Capture constraints follow the configured stream quality.
      await perform(async () => {
        await engine.current?.captureScreen({ systemAudio: true });
      });
      return;
    }
    const request = ++shareRequest.current;
    const originating = engine.current;
    onRequestShare({
      onShare: (options) => originating.captureNativeScreen(options),
      onBrowser: async () => {
        await originating.captureScreen(
          { systemAudio: true },
          () => request === shareRequest.current && originating === engine.current,
        );
      },
      onClose: () => {
        if (request !== shareRequest.current) return;
        shareRequest.current++;
        void originating.stopNativeScreen();
      },
    });
  }

  async function toggleCamera() {
    await perform(async () => {
      if (!engine.current) {
        onError('Join the call to turn on your camera.');
        return;
      }
      if (locals.has('camera')) await engine.current.setLocalTrack('camera', null);
      else {
        await allowDesktopCapture('camera');
        await engine.current.captureUserMedia({
          camera: cameraConstraints(),
          microphone: false,
        });
      }
    });
  }

  function toggleMute() {
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
        return;
      }
      if (!engine.current || !user) {
        onError('Join the call before recording.');
        return;
      }
      recordedTracks.current.clear();
      const metadata = {
        title: room?.name ?? 'Call recording',
        labels: { ...names, [user.id]: user.name },
      };
      recordingMetadata.current = metadata;
      const session = new TrackRecordingSession({
        ...readRecordingQuality(),
        onAutoStop: (finished) => {
          void archiveRecording(finished, metadata);
          setRecording(false);
          recorder.current = null;
          recordedTracks.current.clear();
          onError(
            'Recording reached its 512 MB limit and stopped. Saving the retained tracks to your library.',
          );
        },
        onError: (error) => onError(error.message),
      });
      session.start(
        [...engine.current.getLocalTracks()]
          .map(([source, track]) => ({ peerId: user.id, source, track }))
          .concat(
            engine.current.getRemoteTracks().map((track) => ({
              peerId: track.peerId,
              source: track.source,
              track: track.track,
            })),
          ),
      );
      recorder.current = session;
      setRecording(true);
      setResult(null);
    });
  }

  const unblockAudio = () => {
    window.dispatchEvent(new Event('bc-audio-unlock'));
    setAudioBlocked(false);
  };

  return {
    engine: engine.current,
    joined,
    busy,
    locals,
    remote,
    peers,
    names,
    stats,
    serverRtt,
    signalingDown,
    remotePresence,
    remoteRecording,
    recording,
    result,
    saveStatus,
    audioBlocked,
    speaking,
    microphone: microphoneState,
    isConnected,
    join,
    leave,
    toggleScreen,
    toggleCamera,
    toggleMute,
    toggleDeafen,
    toggleRecord,
    unblockAudio,
  };
}
