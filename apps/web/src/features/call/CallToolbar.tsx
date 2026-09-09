import { Circle, LayoutGrid, Maximize2, Plus } from 'lucide-react';
import CameraOverlay from './CameraOverlay';
import type { GalleryLayout } from './stageItems';
import type { useCallLayout } from './useCallLayout';

type Docking = ReturnType<typeof useCallLayout>;

/** The controls above the stage: layout, docking, overlay, invite and fullscreen. */
export default function CallToolbar({
  recording,
  remoteRecording,
  names,
  galleryLayout,
  onGalleryLayout,
  galleryFit,
  onToggleGalleryFit,
  hasStageContent,
  showAllMedia,
  watchedScreenCount,
  onClearFocus,
  docking,
  overlayCameras,
  focused,
  fullscreen,
  onInvite,
  onFocus,
  onFullscreen,
}: {
  recording: boolean;
  remoteRecording: Record<string, boolean>;
  names: Record<string, string>;
  galleryLayout: GalleryLayout;
  onGalleryLayout: (layout: GalleryLayout) => void;
  galleryFit: 'cover' | 'contain';
  onToggleGalleryFit: () => void;
  hasStageContent: boolean;
  showAllMedia: boolean;
  watchedScreenCount: number;
  onClearFocus: () => void;
  docking: Docking;
  overlayCameras: Parameters<typeof CameraOverlay>[0]['cameras'];
  focused: boolean;
  fullscreen: boolean;
  onInvite: () => void;
  onFocus?: () => void;
  onFullscreen: () => void;
}) {
  const remoteRecorders = Object.entries(remoteRecording)
    .filter(([, value]) => value)
    .map(([id]) => names[id] ?? 'Friend');

  return (
    <div className="call-layout-toolbar">
      {(recording || remoteRecorders.length > 0) && (
        <span className="recording-badge">
          <Circle size={9} fill="currentColor" />{' '}
          {recording ? 'RECORDING' : remoteRecorders.join(', ') + ' IS RECORDING'}
        </span>
      )}
      <div className="gallery-layout-tools" role="group" aria-label="Call layout controls">
        <label>
          View{' '}
          <select
            aria-label="Call layout"
            value={galleryLayout}
            onChange={(event) => onGalleryLayout(event.target.value as GalleryLayout)}
          >
            <option value="adaptive">Adaptive</option>
            <option value="grid">Equal cameras</option>
            <option value="focus">Focus camera</option>
            <option value="all">Everyone + screens</option>
          </select>
        </label>
        {!hasStageContent && (
          <button onClick={onToggleGalleryFit} aria-pressed={galleryFit === 'contain'}>
            {galleryFit === 'cover' ? 'Fill tiles' : 'Fit video'}
          </button>
        )}
      </div>
      {hasStageContent && (
        <>
          <label>
            Camera position{' '}
            <select
              aria-label="Camera position"
              value={docking.dock}
              onChange={(event) =>
                docking.setDock(event.target.value as 'top' | 'left' | 'right')
              }
            >
              <option value="top">Top row</option>
              <option value="left">Left side</option>
              <option value="right">Right side</option>
            </select>
          </label>
          {showAllMedia && (
            <button onClick={onClearFocus}>
              <LayoutGrid size={15} /> Back to all media
            </button>
          )}
          {watchedScreenCount > 1 && (
            <button onClick={onClearFocus}>
              <LayoutGrid size={15} /> Show {watchedScreenCount} screens
            </button>
          )}
          <button onClick={docking.reset}>Reset layout</button>
        </>
      )}
      <CameraOverlay cameras={overlayCameras} />
      <button onClick={onInvite} aria-label="Invite to call">
        <Plus size={16} /> Invite
      </button>
      <button onClick={onFocus} aria-pressed={focused}>
        {focused ? 'Show navigation' : 'Focus call'}
      </button>
      <button
        onClick={onFullscreen}
        aria-label={fullscreen ? 'Exit fullscreen call' : 'Fullscreen call'}
      >
        <Maximize2 size={16} />
      </button>
    </div>
  );
}
