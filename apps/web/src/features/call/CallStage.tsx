import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { talkBindingLabel } from '@/media/pushToTalk';
import type { User, Room } from '@/api';
import ConnectionStatus from './ConnectionStatus';
import CallControls from './CallControls';
import CallLobby from './CallLobby';
import CallToolbar from './CallToolbar';
import ConnectionDetails from './ConnectionDetails';
import RecordingNotice from './RecordingNotice';
import StageArea from './StageArea';
import { CameraTile, ScreenShareTile } from './CameraTile';
import { RemoteAudio } from './PeerAudio';
import { CopilotPanel } from './VisualCopilot';
import { useCallLayout } from './useCallLayout';
import { useCallSession } from './useCallSession';
import { useGalleryPreferences } from './useGalleryPreferences';
import { useImmersiveControls } from './useImmersiveControls';
import { useStageSelection } from './useStageSelection';
import {
  buildStageItems,
  cameraKey,
  screenKey,
  shareIdOf,
  type CameraParticipant,
  type ScreenShare,
} from './stageItems';
import { EMPTY_CALL_PRESENCE, type CallPresence } from './callTypes';
import './CallBase.css';
import './CallLobby.css';
import './CallWorkspace.css';

export type { CallPresence, NativeShareActions } from './callTypes';

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
  onError: (message: string) => void;
  onInvite: () => void;
  onRecordings: () => void;
  onRequestShare: (actions: import('./callTypes').NativeShareActions) => void;
  callPresence?: CallPresence[];
  presenceKnown?: boolean;
}) {
  const call = useCallSession({ user, room, noise, callPresence, onError, onRequestShare });
  const {
    joined,
    busy,
    locals,
    remote,
    peers,
    names,
    speaking,
    remotePresence,
    microphone,
  } = call;
  const { muted, deafened, manualMuted, transmitting, settings: talkSettings } = microphone;

  const workspace = useRef<HTMLDivElement>(null);
  const docking = useCallLayout(layout, onLayout, joined);
  const immersive = useImmersiveControls(workspace, onError);
  const [cameraAspects, setCameraAspects] = useState<Record<string, number>>({});
  const [featuredCamera, setFeaturedCamera] = useState('self');
  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    onJoinedChange?.(joined);
  }, [joined, onJoinedChange]);

  const shares: ScreenShare[] = [
    ...(locals.has('screen')
      ? [
          {
            id: 'local',
            name: 'Your screen',
            track: locals.get('screen')!,
            reencoded: false,
          },
        ]
      : []),
    ...remote
      .filter((track) => track.source === 'screen')
      .map((track) => ({
        id: track.peerId,
        name: (names[track.peerId] ?? 'Friend') + '’s screen',
        track: track.track,
        // The sender's direct native connection failed and it is re-encoding its
        // own decoded preview. Say so instead of looking like a bad share.
        reencoded: track.screenTransport === 'native-compatibility',
      })),
  ];
  const cameraParticipants: CameraParticipant[] = [
    { id: 'self', name: user?.name ?? 'You', track: locals.get('camera'), self: true },
    ...Object.keys(peers).map((id) => ({
      id,
      name: names[id] ?? 'Friend',
      track: remote.find((track) => track.peerId === id && track.source === 'camera')?.track,
      self: false,
    })),
  ];
  const availableStageItems = buildStageItems(shares, cameraParticipants);

  const selection = useStageSelection(shares, availableStageItems);
  const { focusedStageItem, watchedScreens, watchedShareIds, focusedStageKey } = selection;
  const gallery = useGalleryPreferences((value) => {
    if (value === 'all') selection.setFocusedStageKey(null);
  });

  useEffect(() => {
    if (!joined) selection.clearSelection();
  }, [joined, selection.clearSelection]);

  const unifiedGrid = gallery.galleryLayout === 'all' && !focusedStageItem;
  const stageItems = focusedStageItem ? [focusedStageItem] : unifiedGrid ? [] : watchedScreens;
  const hasStageContent = stageItems.length > 0;
  const connectedCount = Object.keys(peers).filter(call.isConnected).length;

  const activeSpeakerCamera = cameraParticipants.find((camera) =>
    speaking.has(camera.id),
  )?.id;
  const activeFeaturedCamera =
    gallery.galleryLayout === 'adaptive' && activeSpeakerCamera
      ? activeSpeakerCamera
      : cameraParticipants.some((camera) => camera.id === featuredCamera)
        ? featuredCamera
        : cameraParticipants[0]?.id;

  /** A camera goes to the stage when there is content to share it with, and is
   * otherwise promoted to the featured tile in the gallery. */
  const focusCamera = (id: string) => {
    if (hasStageContent || shares.length) selection.setFocusedStageKey(cameraKey(id));
    else {
      setFeaturedCamera(id);
      gallery.setGalleryLayout('focus');
    }
  };
  const cameraFocusPressed = (id: string) =>
    focusedStageKey === cameraKey(id) ||
    (!hasStageContent &&
      gallery.galleryLayout === 'focus' &&
      activeFeaturedCamera === id);
  const onStageLabel = (name: string, id: string) =>
    hasStageContent || shares.length
      ? id === 'self'
        ? 'Put your camera on stage'
        : `Put ${name} on stage`
      : `Focus ${id === 'self' ? 'You' : name}`;
  const trackAspect = (id: string) => (ratio: number) =>
    setCameraAspects((current) =>
      current[id] === ratio ? current : { ...current, [id]: ratio },
    );

  if (!joined)
    return (
      <>
        <CallLobby
          user={user}
          room={room}
          busy={busy}
          names={names}
          callPresence={callPresence}
          presenceKnown={presenceKnown}
          onJoin={call.join}
        />
        {call.result && (
          <RecordingNotice
            variant="lobby"
            result={call.result}
            saveStatus={call.saveStatus}
            onRecordings={onRecordings}
          />
        )}
      </>
    );

  return (
    <div
      className="call-workspace"
      ref={workspace}
      data-controls-visible={!immersive.fullscreen || immersive.controlsVisible}
      onPointerMove={immersive.onPointerMove}
      onKeyDown={() => immersive.reveal()}
    >
      {call.engine && <CopilotPanel copilot={call.engine.copilot} names={names} />}
      <CallToolbar
        recording={call.recording}
        remoteRecording={call.remoteRecording}
        names={names}
        galleryLayout={gallery.galleryLayout}
        onGalleryLayout={gallery.setGalleryLayout}
        galleryFit={gallery.galleryFit}
        onToggleGalleryFit={gallery.toggleGalleryFit}
        hasStageContent={hasStageContent}
        showAllMedia={gallery.galleryLayout === 'all' && Boolean(focusedStageItem)}
        watchedScreenCount={focusedStageItem ? watchedScreens.length : 0}
        onClearFocus={() => selection.setFocusedStageKey(null)}
        docking={docking}
        overlayCameras={[
          ...(locals.get('camera')
            ? [
                {
                  id: 'self',
                  name: 'You',
                  track: locals.get('camera')!,
                  speaking: speaking.has('self'),
                  muted,
                  deafened,
                },
              ]
            : []),
          ...remote
            .filter((track) => track.source === 'camera')
            .map((track) => ({
              id: track.peerId,
              name: names[track.peerId] ?? 'Friend',
              track: track.track,
              speaking: speaking.has(track.peerId),
              muted: remotePresence[track.peerId]?.muted,
              deafened: remotePresence[track.peerId]?.deafened,
            })),
        ]}
        focused={focused}
        fullscreen={immersive.fullscreen}
        onInvite={() => immersive.leavingFullscreen(onInvite)}
        onFocus={onFocus}
        onFullscreen={immersive.toggleFullscreen}
      />
      <div
        ref={docking.stage}
        data-joined={joined}
        className="stage"
        data-dock={docking.dock}
        data-has-share={hasStageContent}
        data-content-count={stageItems.length}
        data-gallery={gallery.galleryLayout}
        data-camera-fit={gallery.galleryFit}
        data-camera-count={cameraParticipants.length + shares.length}
        style={{ '--camera-size': docking.size + 'px' } as CSSProperties}
      >
        <div className="camera-dock">
          <button
            className="camera-dock-handle"
            aria-label="Drag cameras to dock"
            {...docking.moveHandlers}
          >
            ⠿ Cameras · drag to dock
          </button>
          <div className="camera-strip">
            {cameraParticipants.map((camera) => (
              <CameraTile
                key={camera.id}
                name={camera.name}
                caption={camera.self ? `${camera.name} · you` : camera.name}
                track={camera.track}
                self={camera.self}
                speaking={speaking.has(camera.id)}
                featured={activeFeaturedCamera === camera.id}
                muted={camera.self ? muted : remotePresence[camera.id]?.muted}
                deafened={camera.self ? deafened : remotePresence[camera.id]?.deafened}
                aspect={cameraAspects[camera.id] ?? 16 / 9}
                canFocus={cameraParticipants.length > 1 || shares.length > 0}
                focusLabel={onStageLabel(camera.name, camera.id)}
                focusPressed={cameraFocusPressed(camera.id)}
                onFocus={() => focusCamera(camera.id)}
                onAspectRatio={trackAspect(camera.id)}
                connection={call.isConnected(camera.id) ? 'connected' : 'connecting'}
                volume={
                  camera.self ? undefined : { peerId: camera.id, remote, balanced }
                }
              />
            ))}
            {shares
              .filter((share) => unifiedGrid || !watchedShareIds.includes(share.id))
              .map((share) => (
                <ScreenShareTile
                  key={`screen-preview:${share.id}`}
                  share={share}
                  watching={watchedShareIds.includes(share.id)}
                  focused={focusedStageKey === screenKey(share.id)}
                  onFocus={() => selection.focusShare(share.id)}
                  onToggleWatch={() => selection.toggleWatchedShare(share.id)}
                />
              ))}
          </div>
        </div>
        {hasStageContent && (
          <div
            className="camera-divider"
            role="separator"
            tabIndex={0}
            aria-label="Resize cameras"
            aria-orientation={docking.dock === 'top' ? 'horizontal' : 'vertical'}
            aria-valuemin={docking.minimum}
            aria-valuemax={docking.maximum}
            aria-valuenow={Math.round(docking.size)}
            {...docking.resizeHandlers}
            onKeyDown={docking.resizeKey}
          />
        )}
        {docking.target && (
          <div className="dock-targets" aria-hidden="true">
            <span data-active={docking.target === 'left'}>Left</span>
            <span data-active={docking.target === 'top'}>Top</span>
            <span data-active={docking.target === 'right'}>Right</span>
          </div>
        )}
        {remote
          .filter(
            (track) =>
              track.track.kind === 'audio' &&
              (track.source !== 'system' || watchedShareIds.includes(track.peerId)),
          )
          .map((track) => (
            <RemoteAudio
              key={track.peerId + track.source + track.track.id}
              track={track.track}
              peerId={track.peerId}
              source={track.source}
              balanced={balanced}
            />
          ))}
        {call.audioBlocked && (
          <Button variant="secondary" onClick={call.unblockAudio}>
            <Volume2 size={17} /> Enable call audio
          </Button>
        )}
        <StageArea
          items={stageItems}
          copilot={call.engine?.copilot}
          names={names}
          contentFit={gallery.contentFit}
          focused={Boolean(focusedStageItem)}
          connectedCount={connectedCount}
          busy={busy}
          onFocusItem={selection.setFocusedStageKey}
          onRemoveItem={(item) =>
            item.kind === 'screen'
              ? selection.toggleWatchedShare(shareIdOf(item.key))
              : selection.setFocusedStageKey(null)
          }
          onToggleFit={gallery.toggleContentFit}
          onFullscreen={immersive.toggleFullscreen}
          onShare={call.toggleScreen}
        />
      </div>
      <div className="call-footer">
        {talkSettings.enabled && (
          <span className="push-to-talk-status" role="status" title={microphone.globalMessage}>
            {microphone.globalStatus === 'unavailable' ||
            microphone.globalStatus === 'connecting'
              ? microphone.globalMessage
              : deafened
                ? 'Deafened'
                : manualMuted
                  ? 'Microphone muted'
                  : !transmitting
                    ? `Hold ${talkBindingLabel(talkSettings.binding)} to talk${microphone.globalStatus === 'active' ? ' · Global' : ''}`
                    : 'Push-to-talk · Transmitting'}
          </span>
        )}
        {call.signalingDown && (
          <span
            className="signaling-reconnecting"
            role="status"
            title="The signaling server is unreachable. Calls already connected keep running peer to peer; joining, sharing and camera changes resume when it returns."
          >
            Reconnecting to server · call continues
          </span>
        )}
        <ConnectionStatus
          joined={joined}
          peerCount={Object.keys(peers).length}
          serverRtt={call.serverRtt}
          stats={call.stats}
          names={names}
          onDetails={() => setShowStats(!showStats)}
        />
        <CallControls
          joined={joined}
          busy={busy}
          signedIn={Boolean(user)}
          muted={muted}
          manualMuted={manualMuted}
          deafened={deafened}
          cameraOn={locals.has('camera')}
          sharing={locals.has('screen')}
          recording={call.recording}
          onToggleMute={call.toggleMute}
          onToggleDeafen={call.toggleDeafen}
          onToggleCamera={call.toggleCamera}
          onToggleShare={call.toggleScreen}
          onToggleRecord={call.toggleRecord}
          onLeave={call.leave}
          onJoin={() => call.join('replace')}
        />
      </div>
      {showStats && (
        <ConnectionDetails
          serverRtt={call.serverRtt}
          stats={call.stats}
          names={names}
          locals={locals}
          remote={remote}
          engine={call.engine}
          workspace={workspace.current}
        />
      )}
      {call.result && (
        <RecordingNotice
          variant="call"
          result={call.result}
          saveStatus={call.saveStatus}
          onRecordings={() => immersive.leavingFullscreen(onRecordings)}
        />
      )}
    </div>
  );
}
