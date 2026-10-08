import {
  Circle,
  LayoutGrid,
  Ellipsis,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelsTopLeft,
  PictureInPicture2,
  Plus,
  Square,
} from 'lucide-react';
import CameraSourceMenu from './CameraSourceMenu';
import { ClipMenuItems } from '@/features/clips/ClipSession';
import { canUseFullscreen } from './fullscreenSupport';
import type { useCallLayout } from './useCallLayout';
import type { GalleryLayout } from './stageItems';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Everything in a phone call that is not a microphone, camera, share or leave.
 *
 * On a desktop these are a row of labelled buttons beside the controls. A
 * phone has room for one row of thumb-sized buttons, and the desktop layout
 * wrapped into three rows that sat on top of the cameras, so the less frequent
 * actions live behind one button at the end of that row.
 */
export default function CallMoreMenu({
  busy,
  recording,
  onToggleRecord,
  cameraOverlayEnabled,
  onToggleCameraOverlay,
  onSelectCamera,
  focusedMedia,
  watchedScreenCount,
  onClearFocus,
  docking,
  galleryLayout,
  onGalleryLayout,
  galleryFit,
  onToggleGalleryFit,
  hasStageContent,
  onChat,
  chatOpen,
  onInvite,
  focused,
  onFocus,
  fullscreen,
  onFullscreen,
}: {
  busy: boolean;
  onSelectCamera: (deviceId: string) => Promise<void>;
  focusedMedia: boolean;
  watchedScreenCount: number;
  onClearFocus: () => void;
  docking: ReturnType<typeof useCallLayout>;
  recording: boolean;
  onToggleRecord: () => void;
  cameraOverlayEnabled?: boolean;
  onToggleCameraOverlay?: () => void;
  galleryLayout: GalleryLayout;
  onGalleryLayout: (layout: GalleryLayout) => void;
  galleryFit: 'cover' | 'contain';
  onToggleGalleryFit: () => void;
  hasStageContent: boolean;
  onChat?: () => void;
  chatOpen?: boolean;
  onInvite?: () => void;
  focused: boolean;
  onFocus?: () => void;
  fullscreen: boolean;
  onFullscreen: () => void;
}) {
  // iPhone WebKit has no element fullscreen; offering it there does nothing.
  const canFullscreen =
    typeof document !== 'undefined' && canUseFullscreen(document);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="secondary"
            size="icon"
            aria-label="More call options"
          />
        }
      >
        <Ellipsis size={19} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-60">
        <CameraSourceMenu busy={busy} onSelect={onSelectCamera} submenu />
        {onToggleCameraOverlay && (
          <DropdownMenuItem onClick={onToggleCameraOverlay}>
            <PictureInPicture2 />{' '}
            {cameraOverlayEnabled
              ? 'Hide camera overlay'
              : 'Show camera overlay'}
          </DropdownMenuItem>
        )}
        {hasStageContent && focusedMedia && (
          <DropdownMenuItem onClick={onClearFocus}>
            <LayoutGrid />{' '}
            {watchedScreenCount > 1
              ? `Show ${watchedScreenCount} screens`
              : 'Back to all media'}
          </DropdownMenuItem>
        )}
        {onChat && (
          <DropdownMenuItem onClick={onChat}>
            <MessageSquare /> {chatOpen ? 'Hide chat' : 'Chat'}
          </DropdownMenuItem>
        )}
        {onInvite && (
          <DropdownMenuItem onClick={onInvite}>
            <Plus /> Invite to call
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          variant={recording ? 'destructive' : 'default'}
          disabled={busy}
          onClick={onToggleRecord}
        >
          {recording ? <Square /> : <Circle />}
          {recording ? 'Stop recording' : 'Record separate tracks'}
        </DropdownMenuItem>
        <ClipMenuItems />
        {onFocus && (
          <DropdownMenuItem onClick={onFocus}>
            <PanelsTopLeft /> {focused ? 'Show navigation' : 'Focus call'}
          </DropdownMenuItem>
        )}
        {canFullscreen && (
          <DropdownMenuItem onClick={onFullscreen}>
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="py-1.5 text-[0.65rem] tracking-wide uppercase">
            Arrangement
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuRadioGroup
          value={galleryLayout}
          onValueChange={(value) => onGalleryLayout(value as GalleryLayout)}
        >
          <DropdownMenuRadioItem value="adaptive">
            Adaptive
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="grid">
            Equal cameras
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="focus">
            Focus camera
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="all">
            Everyone + screens
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {hasStageContent && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Cameras</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuRadioGroup
              value={docking.dock}
              onValueChange={(value) =>
                docking.setDock(value as 'top' | 'left' | 'right')
              }
            >
              <DropdownMenuRadioItem value="top">Top row</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="left">
                Left side
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="right">
                Right side
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuItem onClick={docking.reset}>
              Reset layout
            </DropdownMenuItem>
          </>
        )}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
