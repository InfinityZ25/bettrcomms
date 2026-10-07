import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  MediaEngine,
  MediaEngineDisposedError,
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
import {
  cameraCaptureConstraints,
  captureCameraWithFallback,
  readCameraSettings,
} from '@/media/cameraSettings';
import {
  META_GLASSES_CAMERA_ID,
  startMetaGlassesCamera,
} from '@/media/metaGlassesCamera';
import { hasIOSBroadcast } from '@/media/iosBroadcast';
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
import { readConnectionMode } from '@/media/connectionMode';
import { startIOSCallAudio, stopIOSCallAudio } from '@/desktop/iosCallAudio';
import { hasDesktopCapability } from '@/desktop/capabilities';
import { errorMessage } from '@/lib/errors';
import { readStored, writeStored } from '@/lib/storage';
import { createCallPeerId } from './callPeerId';
import type {
  CallPresence,
  JoinMode,
  NativeShareActions,
  RecordingSaveState,
} from './callTypes';

/** Under half the credentials' ten-minute lifetime. */
const ICE_REFRESH_MS = 4 * 60_000;
/** After a failed renewal, try again this much sooner. */
const ICE_RETRY_MS = 30_000;
/** How long credentials from /ice remain valid. */
const ICE_LIFETIME_MS = 10 * 60_000;

type PeerFlags = { muted: boolean; deafened: boolean };
type RecordingMetadata = { title: string; labels: Record<string, string> };

const captureOptions = () =>
  microphoneCaptureOptions(readStored('bc-input') ?? '');
const cameraConstraints = () =>
  cameraCaptureConstraints(readStored('bc-camera') ?? '', readCameraSettings());

async function captureSelectedCamera(
  media: MediaEngine,
  deviceId: string,
): Promise<void> {
  if (deviceId === META_GLASSES_CAMERA_ID) {
    const glasses = await startMetaGlassesCamera();
    try {
      await media.setLocalTrack('camera', glasses.track, glasses.dispose);
    } catch (error) {
      glasses.dispose();
      throw error;
    }
  } else {
    await allowDesktopCapture('camera');
    await captureCameraWithFallback(
      (camera) => media.captureUserMedia({ camera, microphone: false }),
      deviceId,
    );
  }
}

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
  onRoomChange,
}: {
  user: User | null;
  room: Room | null;
  noise: boolean;
  callPresence: CallPresence[];
  onError: (message: string) => void;
  onRequestShare: (actions: NativeShareActions) => void;
  onRoomChange?: (room: Room | null) => void;
}) {
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locals, setLocals] = useState<Map<MediaSourceKind, MediaStreamTrack>>(
    new Map(),
  );
  const [remote, setRemote] = useState<RemoteTrack[]>([]);
  const [peers, setPeers] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState<RecordingResult | null>(null);
  /*
    What became of it, rather than a sentence about what became of it. The
    words belong to whatever is showing the notice; this is the fact, and the
    id is what makes the notice mortal: a confirmation that a recording was
    saved must not outlive the recording.
  */
  const [saveState, setSaveState] = useState<RecordingSaveState>('saving');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [stats, setStats] = useState<PeerMediaStats[]>([]);
  const serverRtt = useRef<number | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [remotePresence, setRemotePresence] = useState<
    Record<string, PeerFlags>
  >({});
  const [remoteRecording, setRemoteRecording] = useState<
    Record<string, boolean>
  >({});
  /** Signaling is retrying. Media continues; setup and membership pause. */
  const [signalingDown, setSignalingDown] = useState(false);

  const engine = useRef<MediaEngine | null>(null);
  const socket = useRef<RoomWebSocketSignaling | null>(null);
  const recorder = useRef<TrackRecordingSession | null>(null);
  const shareRequest = useRef(0);
  const active = useRef(true);
  const busyRef = useRef(false);
  const actionGeneration = useRef(0);
  const joinGeneration = useRef(0);
  const sessionAbort = useRef<AbortController | null>(null);
  const joinedRoom = useRef<Room | null>(null);
  const reportRoom = useRef(onRoomChange);
  reportRoom.current = onRoomChange;
  const recordedTracks = useRef(new Set<string>());
  const recordingMetadata = useRef<RecordingMetadata>({
    title: 'Call recording',
    labels: {},
  });

  const [callMicrophone] = useState(
    () =>
      new CallMicrophone(
        (enabled) => engine.current?.setMicrophoneEnabled(enabled),
        setCallPlaybackDeafened,
      ),
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
    stats.some(
      (peer) => peer.peerId === id && peer.voiceRelay?.state === 'relayed',
    );

  const speaking = useSpeakingActivity(
    [
      ...(locals.get('microphone') && !muted
        ? [{ id: 'self', track: locals.get('microphone')! }]
        : []),
      ...remote
        .filter(
          (track) => track.source === 'microphone' && isConnected(track.peerId),
        )
        .map((track) => ({ id: track.peerId, track: track.track })),
    ],
    joined,
  );

  async function perform(task: () => Promise<void>): Promise<boolean> {
    if (busyRef.current) return false;
    const generation = ++actionGeneration.current;
    busyRef.current = true;
    setBusy(true);
    try {
      await task();
      return true;
    } catch (error) {
      // Tearing the call down mid-operation is not something to report.
      if (
        active.current &&
        generation === actionGeneration.current &&
        !(error instanceof MediaEngineDisposedError) &&
        !(error instanceof DOMException && error.name === 'AbortError')
      )
        onError(errorMessage(error));
      return false;
    } finally {
      if (generation === actionGeneration.current) {
        busyRef.current = false;
        if (active.current) setBusy(false);
      }
    }
  }

  const archiveRecording = async (
    finished: RecordingResult,
    metadata: RecordingMetadata,
  ) => {
    if (active.current) {
      setResult(finished);
      setSavedId(null);
      setSaveState('saving');
    }
    try {
      const saved = await saveRecording(finished, metadata);
      if (active.current) {
        setSavedId(saved.id);
        setSaveState('saved');
      }
    } catch (error) {
      if (active.current) {
        setSaveState('failed');
        onError(errorMessage(error));
      }
    }
  };

  /**
   * Put the notice away.
   *
   * It used to stay until the next recording started, which meant a line
   * saying where a recording went outlived leaving the call, and outlived the
   * recording itself once it was deleted.
   */
  const dismissResult = () => {
    setResult(null);
    setSavedId(null);
    setSaveState('saving');
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
    joinGeneration.current++;
    sessionAbort.current?.abort();
    sessionAbort.current = null;
    actionGeneration.current++;
    busyRef.current = false;
    setBusy(false);
    shareRequest.current++;
    callMicrophone.stop();
    void stopIOSCallAudio().catch(() => {});
    disposeCallPlayback();
    // Clears the confirmation from an earlier recording; one that is still
    // running is stopped and archived below and raises a fresh notice of its
    // own. A failed save is the exception: that recording exists nowhere else,
    // so its notice outlives the call until somebody deals with it.
    if (saveState !== 'failed') dismissResult();
    void finishRecording();
    socket.current?.close();
    socket.current = null;
    engine.current?.dispose();
    engine.current = null;
    joinedRoom.current = null;
    reportRoom.current?.(null);
    setJoined(false);
    setSignalingDown(false);
    serverRtt.current = null;
    setStats([]);
    setLocals(new Map());
    setRemote([]);
    setPeers({});
    setNames({});
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
      joinGeneration.current++;
      sessionAbort.current?.abort();
      sessionAbort.current = null;
      socket.current?.close();
      engine.current?.dispose();
      void stopIOSCallAudio().catch(() => {});
      disposeCallPlayback();
      const metadata = recordingMetadata.current;
      void recorder.current
        ?.stop()
        .then((finished) => archiveRecording(finished, metadata))
        .catch(() => {});
      recorder.current = null;
    };
  }, []);

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
    if (recorder.current)
      Object.assign(recordingMetadata.current.labels, names);
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
              response.members.map((member) => [
                member.user.id,
                member.user.name,
              ]),
            ),
            ...current,
          }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [room?.id, user?.id, peerIds]);

  // Relay credentials last ten minutes. Renew them well inside that, so a
  // late joiner or a route repair is never handed expired ones.
  //
  // The first renewal runs as soon as the call is joined: the credentials used
  // to set it up were fetched before any permission prompt, which can stay
  // open for minutes. A failed renewal is retried after thirty seconds, and
  // if the credentials do run out the user is told once, since relayed
  // connections may then fail to reconnect.
  const reportIceError = useRef(onError);
  reportIceError.current = onError;
  useEffect(() => {
    if (!joined) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renewedAt = Date.now();
    let warned = false;
    const renew = () => {
      const current = engine.current;
      if (!current) return;
      void api<{ ice_servers: RTCIceServer[] }>('/ice')
        .then((config) => {
          if (!live || engine.current !== current) return;
          current.setIceServers(config.ice_servers);
          renewedAt = Date.now();
          warned = false;
          timer = setTimeout(renew, ICE_REFRESH_MS);
        })
        .catch((error) => {
          if (!live) return;
          console.warn('Could not renew relay credentials', error);
          if (!warned && Date.now() - renewedAt >= ICE_LIFETIME_MS) {
            warned = true;
            reportIceError.current(
              'Could not renew relay access. If your connection drops, rejoin the call.',
            );
          }
          timer = setTimeout(renew, ICE_RETRY_MS);
        });
    };
    renew();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [joined]);

  useEffect(() => {
    if (!joined) return;
    let live = true;
    let pending = false;
    const poll = () => {
      const current = engine.current;
      if (!current || pending) return;
      pending = true;
      Promise.all(
        Object.keys(peers).map((id) => current.getStats(id).catch(() => null)),
      )
        .then((results) => {
          if (live)
            setStats(
              results.filter((peer): peer is PeerMediaStats => peer !== null),
            );
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
        await engine.current.captureUserMedia({
          camera: false,
          ...captureOptions(),
        });
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
      engine.current
        ?.setQuality(readQuality())
        .catch((error) => onError(error.message));
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
          camera:
            current.getLocalTracks().has('camera') &&
            readStored('bc-camera') !== META_GLASSES_CAMERA_ID
              ? cameraConstraints()
              : false,
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
        if (readStored('bc-camera') === META_GLASSES_CAMERA_ID) return;
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

  async function join(
    joinMode: JoinMode = 'replace',
    targetRoom: Room | null = room,
  ): Promise<boolean> {
    if (!user) {
      location.assign('/api/v1/auth/login');
      return false;
    }
    if (!targetRoom) {
      onError('Create a room before joining a call.');
      return false;
    }
    if (
      targetRoom.channel_type === 'announcement' ||
      targetRoom.can_join_voice === false ||
      targetRoom.permissions?.join_voice === false
    ) {
      onError(
        targetRoom.channel_type === 'announcement'
          ? 'Announcement channels have text only. Choose a text and voice channel to join voice.'
          : 'Your room role does not allow joining voice in this channel.',
      );
      return false;
    }
    if (busyRef.current) return false;
    if (engine.current && joinedRoom.current?.id === targetRoom.id) return true;
    // Browsing never changes the live engine. An explicit join into another
    // channel ends the old call and its captures before opening the new one.
    if (engine.current || socket.current || recorder.current) leave();
    prepareCallPlayback();
    const attemptController = new AbortController();
    const success = await perform(async () => {
      const generation = ++joinGeneration.current;
      const controller = attemptController;
      sessionAbort.current = controller;
      const assertCurrent = () => {
        if (
          !active.current ||
          controller.signal.aborted ||
          generation !== joinGeneration.current
        )
          throw new DOMException('Call join cancelled', 'AbortError');
      };
      // Re-read current membership and role before asking for a microphone.
      // The WebSocket still independently authorizes actual voice admission.
      const { room: freshRoom } = await api<{ room: Room }>(
        `/rooms/${targetRoom.id}`,
        undefined,
        undefined,
        controller.signal,
      );
      assertCurrent();
      if (
        freshRoom.channel_type === 'announcement' ||
        freshRoom.can_join_voice === false ||
        freshRoom.permissions?.join_voice === false
      )
        throw new Error(
          freshRoom.channel_type === 'announcement'
            ? 'This channel is now an announcement channel and has no voice call.'
            : 'Your room role no longer allows joining voice in this channel.',
        );
      await allowDesktopCapture('microphone');
      assertCurrent();
      const config = await api<{ ice_servers: RTCIceServer[] }>(
        '/ice',
        undefined,
        undefined,
        controller.signal,
      ).catch((error) => {
        assertCurrent();
        if (error instanceof DOMException && error.name === 'AbortError')
          throw error;
        return api<{ ice_servers: RTCIceServer[] }>(
          '/config',
          undefined,
          undefined,
          controller.signal,
        );
      });
      assertCurrent();
      const peerId = createCallPeerId();
      const query = new URLSearchParams({
        peer_id: peerId,
        join_mode: joinMode,
      });
      const connection = new RoomWebSocketSignaling(
        peerId,
        `/api/v1/rooms/${targetRoom.id}/ws?${query}`,
      );
      const connectionMode = readConnectionMode();
      const media = new MediaEngine({
        signaling: connection,
        voiceRelay: {
          url: `/api/v1/rooms/${targetRoom.id}/voice-relay?peer_id=${encodeURIComponent(peerId)}`,
          mode:
            readStored('bc-voice-route') === 'relay' ? 'relay' : 'automatic',
        },
        quality: readQuality(),
        ice: {
          mode:
            connectionMode === 'automatic'
              ? 'direct-preferred'
              : connectionMode,
          iceServers: config.ice_servers,
        },
      });
      engine.current = media;
      callMicrophone.start();
      socket.current = connection;
      const listenerOptions = { signal: controller.signal };
      const ownsSession = () =>
        active.current &&
        engine.current === media &&
        socket.current === connection;

      connection.addEventListener(
        'latency',
        (event) => {
          if (socket.current === connection)
            serverRtt.current = event.detail.rttMs;
        },
        listenerOptions,
      );
      media.addEventListener(
        'local-track',
        () => setLocals(new Map(media.getLocalTracks())),
        listenerOptions,
      );
      media.addEventListener(
        'remote-track',
        () => setRemote(media.getRemoteTracks()),
        listenerOptions,
      );
      media.addEventListener(
        'remote-track-removed',
        () => setRemote(media.getRemoteTracks()),
        listenerOptions,
      );
      media.addEventListener(
        'peer-state',
        (event) =>
          setPeers((current) => ({
            ...current,
            [event.detail.peerId]: event.detail.state,
          })),
        listenerOptions,
      );
      media.addEventListener(
        'error',
        (event) => onError('Media: ' + errorMessage(event.detail.error)),
        listenerOptions,
      );
      media.addEventListener(
        'denoiser-status',
        (event) => onError(event.detail.message),
        listenerOptions,
      );

      connection.addEventListener(
        'peers',
        (event) => {
          for (const id of event.detail.peerIds) {
            media.addPeer(id);
            setPeers((current) =>
              current[id] === undefined
                ? { ...current, [id]: 'connecting' }
                : current,
            );
          }
          setNames((current) => {
            const next = { ...current };
            for (const [id, identity] of Object.entries(
              event.detail.identities,
            ))
              if (identity.name) next[id] = identity.name;
            return next;
          });
        },
        listenerOptions,
      );
      connection.addEventListener(
        'signal',
        (event) => {
          void media.handleSignal(event.detail).catch((error) => {
            if (ownsSession()) onError(error.message);
          });
        },
        listenerOptions,
      );
      connection.addEventListener(
        'peer-joined',
        (event) => {
          const { peerId: id, name } = event.detail;
          media.addPeer(id);
          setPeers((current) =>
            current[id] === undefined
              ? { ...current, [id]: 'connecting' }
              : current,
          );
          if (name) setNames((current) => ({ ...current, [id]: name }));
        },
        listenerOptions,
      );
      connection.addEventListener(
        'peer-left',
        (event) => {
          const { peerId: id } = event.detail;
          const without = <T>(record: Record<string, T>) => {
            const next = { ...record };
            delete next[id];
            return next;
          };
          setRemotePresence(without);
          setRemoteRecording(without);
          media.removePeer(id);
          setPeers(without);
        },
        listenerOptions,
      );
      connection.addEventListener(
        'presence',
        (event) => {
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
          setRemoteRecording((current) => ({
            ...current,
            [id]: Boolean(payload?.recording),
          }));
          if (payload?.name)
            setNames((current) => ({ ...current, [id]: payload.name! }));
        },
        listenerOptions,
      );

      // Signaling carries setup and membership, not media. Established peer
      // connections keep flowing while the server restarts, so a dropped socket
      // is a degraded state, not the end of the call.
      connection.addEventListener(
        'disconnected',
        () => {
          if (socket.current === connection) setSignalingDown(true);
        },
        listenerOptions,
      );
      connection.addEventListener(
        'reconnected',
        () => {
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
        },
        listenerOptions,
      );
      connection.addEventListener(
        'close',
        () => {
          if (!ownsSession()) return;
          const wasJoined = joinedRoom.current !== null;
          joinGeneration.current++;
          controller.abort();
          if (sessionAbort.current === controller) sessionAbort.current = null;
          setSignalingDown(false);
          callMicrophone.stop();
          void finishRecording();
          media.dispose();
          void stopIOSCallAudio().catch(() => {});
          disposeCallPlayback();
          engine.current = null;
          socket.current = null;
          joinedRoom.current = null;
          reportRoom.current?.(null);
          setJoined(false);
          setCallPlaybackDeafened(false);
          serverRtt.current = null;
          setStats([]);
          setRemote([]);
          setLocals(new Map());
          setPeers({});
          setNames({});
          setRemotePresence({});
          setRemoteRecording({});
          if (wasJoined) onError('Call disconnected. Join again to reconnect.');
        },
        listenerOptions,
      );

      try {
        try {
          await startIOSCallAudio();
        } catch (error) {
          assertCurrent();
          onError(
            `iPhone background audio unavailable: ${errorMessage(error)}`,
          );
        }
        assertCurrent();
        await media.captureUserMedia({ camera: false, ...captureOptions() });
        assertCurrent();
        await connection.connect();
        assertCurrent();
        joinedRoom.current = freshRoom;
        reportRoom.current?.(freshRoom);
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
        const owned = engine.current === media;
        controller.abort();
        connection.close();
        media.dispose();
        if (owned) {
          callMicrophone.stop();
          void stopIOSCallAudio().catch(() => {});
          disposeCallPlayback();
          engine.current = null;
          socket.current = null;
          joinedRoom.current = null;
          reportRoom.current?.(null);
          setJoined(false);
          setLocals(new Map());
          setRemote([]);
          setPeers({});
        }
        if (sessionAbort.current === controller) sessionAbort.current = null;
        throw error;
      }
    });
    if (!engine.current && sessionAbort.current === attemptController) {
      attemptController.abort();
      sessionAbort.current = null;
      disposeCallPlayback();
    } else if (!engine.current && !sessionAbort.current) disposeCallPlayback();
    return (
      success &&
      engine.current !== null &&
      joinedRoom.current?.id === targetRoom.id
    );
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
    if (hasIOSBroadcast()) {
      await perform(async () => {
        await engine.current?.captureIOSAppScreen();
      });
      return;
    }
    // Without native capture (macOS, browsers) the webview's own picker is
    // the share path; Windows keeps its native picker.
    if (!hasDesktopCapability('nativeGameVideo')) {
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
          () =>
            request === shareRequest.current && originating === engine.current,
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
      if (locals.has('camera'))
        await engine.current.setLocalTrack('camera', null);
      else {
        await captureSelectedCamera(
          engine.current,
          readStored('bc-camera') ?? '',
        );
      }
    });
  }

  async function selectCamera(deviceId: string) {
    await perform(async () => {
      const current = engine.current;
      if (!current) {
        onError('Join the call to choose a camera.');
        return;
      }
      const cameraTrack = current.getLocalTracks().get('camera');
      // Choosing a source while video is off must not start publishing it.
      if (
        !cameraTrack ||
        (deviceId &&
          (deviceId === META_GLASSES_CAMERA_ID
            ? readStored('bc-camera') === deviceId
            : cameraTrack.getSettings().deviceId === deviceId))
      ) {
        writeStored('bc-camera', deviceId);
        window.dispatchEvent(new Event('bc-camera-selected'));
        return;
      }
      try {
        await captureSelectedCamera(current, deviceId);
      } catch (error) {
        // The selected device may belong to another app, or the browser may
        // reject opening a second camera. We cannot distinguish those cases;
        // keep the working feed and make the workaround conditional.
        if (
          error instanceof DOMException &&
          ['NotReadableError', 'AbortError'].includes(error.name)
        ) {
          throw new Error(
            'Could not open that camera; it may be busy or unavailable. Your current video is still live. If your browser limits cameras, turn video off, select it, then turn video on.',
          );
        }
        throw error;
      }
      writeStored('bc-camera', deviceId);
      window.dispatchEvent(new Event('bc-camera-selected'));
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
    getServerRtt: () => serverRtt.current,
    signaling: socket.current,
    signalingDown,
    remotePresence,
    remoteRecording,
    recording,
    result,
    saveState,
    savedId,
    dismissResult,
    audioBlocked,
    speaking,
    microphone: microphoneState,
    isConnected,
    join,
    leave,
    toggleScreen,
    toggleCamera,
    selectCamera,
    toggleMute,
    toggleDeafen,
    toggleRecord,
    unblockAudio,
  };
}
