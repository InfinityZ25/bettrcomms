import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { talkBindingLabel } from '@/media/pushToTalk';
import type { User } from '@/api';
import ConnectionStatus from './ConnectionStatus';
import CallControls from './CallControls';
import CallLobby from './CallLobby';
import CallToolbar, { RecordingFlag } from './CallToolbar';
import ConnectionDetails from './ConnectionDetails';
import StageArea from './StageArea';
import { CameraTile, ScreenShareTile } from './CameraTile';
import { CopilotPanel } from './VisualCopilot';
import { useCallLayout } from './useCallLayout';
import { useActiveCall } from './CallSessionContext';
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
import './CallBase.css';
import './CallWorkspace.css';
import './CallPhone.css';
import CallMoreMenu from './CallMoreMenu';
import { useCameraOverlay } from './CameraOverlay';
import { useIsMobile } from '@/hooks/use-mobile';

// Keep the desktop status elements as direct footer children: its grid and
// fullscreen rules depend on that structure. Phones need their own status row.
function CallStatusRow({ phone, children }: { phone: boolean; children: ReactNode }) {
  return phone ? <div className="phone-call-status">{children}</div> : <>{children}</>;
}

export type { CallPresence, NativeShareActions } from './callTypes';

export default function CallStage({
  user,
  layout,
  onLayout,
  focused = false,
  onFocus,
  balanced,
  onError,
  onInvite,
  onChat,
  chatOpen = false,
  hidden = false,
}: {
  user: User | null;
  layout: string;
  onLayout?: (layout: string) => void;
  focused?: boolean;
  onFocus?: () => void;
  balanced: boolean;
  onError: (message: string) => void;
  onInvite?: () => void;
  /** Present in a direct room, where the conversation is the other half. */
  onChat?: () => void;
  /** The conversation is beside this, so the call has less width to work in. */
  chatOpen?: boolean;
  /**
   * Take the stage off screen without unmounting it. Home occupies the same
   * space when nothing is open. Voice playback lives above this screen in the
   * call provider, so hiding the stage cannot silence an active conversation.
   */
  hidden?: boolean;
}) {
  // The session is owned by CallSessionProvider, above the screen tree. This
  // screen renders it and is free to unmount without ending the call.
  const call = useActiveCall();
  const { room, callPresence, presenceKnown } = call;
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
  const phone = useIsMobile();
  const [cameraAspects, setCameraAspects] = useState<Record<string, number>>({});
  const [featuredCamera, setFeaturedCamera] = useState('self');
  const [showStats, setShowStats] = useState(false);

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
  // Native overlay ownership follows the call, independent of responsive UI.
  const cameraOverlay = useCameraOverlay([
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
  ], joined);

  const selection = useStageSelection(shares, availableStageItems);
  const { focusedStageItem, watchedScreens, watchedShareIds, focusedStageKey } = selection;
  useEffect(() => {
    call.setAudibleShareIds(watchedShareIds);
  }, [watchedShareIds, call.setAudibleShareIds]);
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

  // Home has the space when nothing is open, so the lobby would only repeat
  // that nothing is selected. A finished recording is announced by the shell's
  // own notice, which is still on screen after the call ends.
  if (!joined || hidden)
    return hidden ? null : (
      <CallLobby
        user={user}
        room={room}
        busy={busy}
        names={names}
        callPresence={callPresence}
        presenceKnown={presenceKnown}
        onJoin={call.join}
      />
    );

  return (
    <div
      className="call-workspace"
      ref={workspace}
      // An inline style, because the `hidden` attribute is a user-agent rule
      // and `.call-workspace` sets `display` in a stylesheet, which outranks it.
      style={hidden ? { display: 'none' } : undefined}
      inert={hidden}
      data-chat={chatOpen}
      data-controls-visible={immersive.controlsVisible}
      onPointerMove={immersive.onPointerMove}
      onPointerDown={immersive.onPointerDown}
      onKeyDown={() => immersive.reveal()}
    >
      {call.engine && (
        <CopilotPanel copilot={call.engine.copilot} names={names} />
      )}
      <RecordingFlag
        recording={call.recording}
        remoteRecording={call.remoteRecording}
        names={names}
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
                peerId={camera.self ? user?.id : camera.id}
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
        <CallStatusRow phone={phone}>
          {talkSettings.enabled && (
            <span
              className="push-to-talk-status"
              role="status"
              title={microphone.globalMessage}
            >
              {microphone.globalStatus === 'unavailable' ||
              microphone.globalStatus === 'connecting'
                ? microphone.globalMessage
                : deafened
                  ? 'Deafened'
                  : manualMuted
                    ? 'Microphone muted'
                    : !transmitting
                      ? `Hold ${talkBindingLabel(talkSettings.binding)} to talk · ${microphone.globalStatus === 'active' ? 'Global' : 'Focused window only'}`
                      : `Push-to-talk · Transmitting · ${microphone.globalStatus === 'active' ? 'Global' : 'Focused window only'}`}
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
            signaling={call.signaling}
            stats={call.stats}
            names={names}
            onDetails={() => setShowStats(!showStats)}
          />
        </CallStatusRow>
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
          onSelectCamera={call.selectCamera}
          onToggleShare={call.toggleScreen}
          onToggleRecord={call.toggleRecord}
          onLeave={call.leave}
          onJoin={() => call.join('replace')}
          more={
            phone ? (
              <CallMoreMenu
                busy={busy}
                onSelectCamera={call.selectCamera}
                focusedMedia={Boolean(focusedStageItem)}
                watchedScreenCount={watchedScreens.length}
                onClearFocus={() => selection.setFocusedStageKey(null)}
                docking={docking}
                recording={call.recording}
                onToggleRecord={call.toggleRecord}
                cameraOverlayEnabled={cameraOverlay.enabled}
                onToggleCameraOverlay={cameraOverlay.supported ? cameraOverlay.toggle : undefined}
                galleryLayout={gallery.galleryLayout}
                onGalleryLayout={gallery.setGalleryLayout}
                galleryFit={gallery.galleryFit}
                onToggleGalleryFit={gallery.toggleGalleryFit}
                hasStageContent={hasStageContent}
                onChat={onChat && (() => immersive.leavingFullscreen(onChat))}
                chatOpen={chatOpen}
                onInvite={onInvite && (() => immersive.leavingFullscreen(onInvite))}
                focused={focused}
                onFocus={onFocus}
                fullscreen={immersive.fullscreen}
                onFullscreen={immersive.toggleFullscreen}
              />
            ) : undefined
          }
        />
        {/* Keep the native overlay alive when responsive controls move into
            More. Its session ends with the call, not with a window resize. */}
        <CallToolbar
          hidden={phone}
          galleryLayout={gallery.galleryLayout}
          onGalleryLayout={gallery.setGalleryLayout}
          galleryFit={gallery.galleryFit}
          onToggleGalleryFit={gallery.toggleGalleryFit}
          hasStageContent={hasStageContent}
          showAllMedia={
            gallery.galleryLayout === 'all' && Boolean(focusedStageItem)
          }
          watchedScreenCount={focusedStageItem ? watchedScreens.length : 0}
          onClearFocus={() => selection.setFocusedStageKey(null)}
          docking={docking}
          cameraOverlay={cameraOverlay}
          focused={focused}
          fullscreen={immersive.fullscreen}
          onInvite={onInvite && (() => immersive.leavingFullscreen(onInvite))}
          onChat={onChat && (() => immersive.leavingFullscreen(onChat))}
          chatOpen={chatOpen}
          onFocus={onFocus}
          onFullscreen={immersive.toggleFullscreen}
        />
      </div>
      {showStats && (
        <ConnectionDetails
          serverRtt={call.getServerRtt}
          stats={call.stats}
          names={names}
          locals={locals}
          remote={remote}
          engine={call.engine}
          workspace={workspace.current}
        />
      )}
    </div>
  );
}
