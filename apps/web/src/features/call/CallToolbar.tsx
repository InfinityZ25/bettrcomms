import {
  Circle,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Plus,
  SlidersHorizontal,
} from 'lucide-react';
import CameraOverlay from './CameraOverlay';
import type { GalleryLayout } from './stageItems';
import type { useCallLayout } from './useCallLayout';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Docking = ReturnType<typeof useCallLayout>;

/**
 * Somebody is recording.
 *
 * Floated over the stage and never faded out. It travelled with the layout
 * controls while those were a band at the top; now that they leave the screen
 * when the pointer goes still, a recording indicator cannot travel with them.
 */
export function RecordingFlag({
  recording,
  remoteRecording,
  names,
}: {
  recording: boolean;
  remoteRecording: Record<string, boolean>;
  names: Record<string, string>;
}) {
  const remoteRecorders = Object.entries(remoteRecording)
    .filter(([, value]) => value)
    .map(([id]) => names[id] ?? 'Friend');
  if (!recording && remoteRecorders.length === 0) return null;
  return (
    <span className="recording-badge">
      <Circle size={9} fill="currentColor" />
      {recording ? 'Recording' : remoteRecorders.join(', ') + ' is recording'}
    </span>
  );
}

/**
 * Layout, docking, overlay, invite and fullscreen.
 *
 * These used to be a band of their own above the stage, which cost around fifty
 * pixels of height to say nothing while people talked. They are the right-hand
 * cluster of the floating controls now: the footer was already a three-column
 * grid with the controls in the middle, and its third column was empty.
 */
export default function CallToolbar({
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
  onChat,
  chatOpen,
  onFocus,
  onFullscreen,
}: {
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
  /** Absent in a direct room, which is a pair and not a place to add people. */
  onInvite?: () => void;
  onChat?: () => void;
  chatOpen?: boolean;
  onFocus?: () => void;
  onFullscreen: () => void;
}) {
  return (
    <div className="call-chrome-actions">
      {/*
        Everything about how the call is arranged lives behind one button.
        These were four controls spread along the top edge — two raw selects
        among them — which made the first thing you saw in a call a settings
        strip. They are worth having and are not worth looking at while people
        are talking.
      */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" aria-label="Call layout options" />
          }
        >
          <SlidersHorizontal size={15} /> View
        </DropdownMenuTrigger>
        {/* Anchored to its own right edge, so it opens away from Invite and
            Focus call rather than on top of them. */}
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="py-1.5 text-[0.65rem] tracking-wide uppercase">
              Arrangement
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuRadioGroup
            value={galleryLayout}
            onValueChange={(value) => onGalleryLayout(value as GalleryLayout)}
          >
            <DropdownMenuRadioItem value="adaptive">Adaptive</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="grid">Equal cameras</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="focus">Focus camera</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="all">Everyone + screens</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          {!hasStageContent && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={galleryFit === 'cover'}
                onCheckedChange={onToggleGalleryFit}
              >
                Fill tiles
              </DropdownMenuCheckboxItem>
            </>
          )}
          {hasStageContent && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="py-1.5 text-[0.65rem] tracking-wide uppercase">
                  Cameras
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuRadioGroup
                value={docking.dock}
                onValueChange={(value) =>
                  docking.setDock(value as 'top' | 'left' | 'right')
                }
              >
                <DropdownMenuRadioItem value="top">Top row</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="left">Left side</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="right">Right side</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="p-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start font-normal"
                    onClick={docking.reset}
                  >
                    Reset layout
                  </Button>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {hasStageContent && (
        <>
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
        </>
      )}
      <CameraOverlay cameras={overlayCameras} />
      {onChat && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onChat}
          aria-pressed={chatOpen}
        >
          <MessageSquare size={15} /> Chat
        </Button>
      )}
      {onInvite && (
        <Button variant="ghost" size="sm" onClick={onInvite} aria-label="Invite to call">
          <Plus size={16} /> Invite
        </Button>
      )}
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
