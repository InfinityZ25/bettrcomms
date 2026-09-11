import { Circle, LayoutGrid, Maximize2, Plus } from 'lucide-react';
import CameraOverlay from './CameraOverlay';
import type { GalleryLayout } from './stageItems';
import type { useCallLayout } from './useCallLayout';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';

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
          <NativeSelect
            aria-label="Call layout"
            value={galleryLayout}
            onChange={(event) => onGalleryLayout(event.target.value as GalleryLayout)}
          >
            <option value="adaptive">Adaptive</option>
            <option value="grid">Equal cameras</option>
            <option value="focus">Focus camera</option>
            <option value="all">Everyone + screens</option>
          </NativeSelect>
        </label>
        {!hasStageContent && (
          <Button variant="ghost" size="sm" onClick={onToggleGalleryFit} aria-pressed={galleryFit === 'contain'}>
            {galleryFit === 'cover' ? 'Fill tiles' : 'Fit video'}
          </Button>
        )}
      </div>
      {hasStageContent && (
        <>
          <label>
            Camera position{' '}
            <NativeSelect
              aria-label="Camera position"
              value={docking.dock}
              onChange={(event) =>
                docking.setDock(event.target.value as 'top' | 'left' | 'right')
              }
            >
              <option value="top">Top row</option>
              <option value="left">Left side</option>
              <option value="right">Right side</option>
            </NativeSelect>
          </label>
          {showAllMedia && (
            <Button variant="ghost" size="sm" onClick={onClearFocus}>
              <LayoutGrid size={15} /> Back to all media
            </Button>
          )}
          {watchedScreenCount > 1 && (
            <Button variant="ghost" size="sm" onClick={onClearFocus}>
              <LayoutGrid size={15} /> Show {watchedScreenCount} screens
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={docking.reset}>Reset layout</Button>
        </>
      )}
      <CameraOverlay cameras={overlayCameras} />
      <Button variant="ghost" size="sm" onClick={onInvite} aria-label="Invite to call">
        <Plus size={16} /> Invite
      </Button>
      <Button variant="ghost" size="sm" onClick={onFocus} aria-pressed={focused}>
        {focused ? 'Show navigation' : 'Focus call'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onFullscreen}
        aria-label={fullscreen ? 'Exit fullscreen call' : 'Fullscreen call'}
      >
        <Maximize2 size={16} />
      </Button>
    </div>
  );
}
