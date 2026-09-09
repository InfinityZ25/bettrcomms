import { useEffect, useState } from 'react';
import { Maximize2, MonitorUp, Pin, Video, X, ZoomIn, ZoomOut } from 'lucide-react';
import TrackVideo from './TrackVideo';
import { CopilotLocalMarks, CopilotViewerSlot } from './VisualCopilot';
import { useZoomPan } from './useZoomPan';
import { shareIdOf, type StageItem } from './stageItems';
import type { VisualCopilot } from '@/media/visualCopilot';

const DEGRADED_HINT =
  'The direct native connection failed, so this screen is being re-encoded through the call at reduced quality.';

/** One pannable, zoomable screen share or camera on the main stage. */
export default function StagePane({
  copilot,
  names,
  item,
  contentFit,
  canFocus,
  onFocus,
  onRemove,
  onToggleFit,
  onFullscreen,
}: {
  copilot?: VisualCopilot;
  names: Record<string, string>;
  item: StageItem;
  contentFit: 'fit' | 'fill';
  canFocus: boolean;
  onFocus(): void;
  onRemove(): void;
  onToggleFit(): void;
  onFullscreen(): void;
}) {
  const { zoom, pan, dragging, viewport, viewportHandlers, step, reset } = useZoomPan(
    item.track,
  );
  const [receiving, setReceiving] = useState(false);
  useEffect(() => setReceiving(false), [item.track]);

  return (
    <section
      className="stage-content-pane"
      data-kind={item.kind}
      data-dragging={dragging}
      aria-label={item.name}
    >
      <div className="stage-topline">
        <span>
          {item.kind === 'screen' ? <MonitorUp size={15} /> : <Video size={15} />}
          {item.name.toUpperCase()}
        </span>
        <div className="stage-pane-actions">
          {canFocus && (
            <button aria-label={`Focus ${item.name}`} onClick={onFocus}>
              <Pin size={14} /> Focus
            </button>
          )}
          {item.reencoded && (
            <span className="stage-badge stage-badge-degraded" title={DEGRADED_HINT}>
              Reduced quality
            </span>
          )}
          <span className="stage-badge">
            {item.kind === 'camera' || receiving ? 'Live' : 'Waiting for video'}
          </span>
          <button
            aria-label={
              item.kind === 'screen'
                ? `Stop watching ${item.name}`
                : `Return ${item.name} to the camera row`
            }
            onClick={onRemove}
          >
            <X size={15} />
          </button>
        </div>
      </div>
      <div
        ref={viewport}
        className="video-viewport"
        data-pannable={zoom > 1}
        {...viewportHandlers}
      >
        <div
          className="zoom-surface"
          style={{ transform: `translate3d(${pan.x}px,${pan.y}px,0) scale(${zoom})` }}
        >
          <TrackVideo
            track={item.track}
            self={item.kind === 'camera' && item.self}
            showStatus={item.kind === 'screen'}
            onReceiving={item.kind === 'screen' ? setReceiving : undefined}
          />
          {copilot && item.kind === 'screen' && item.self && (
            <CopilotLocalMarks
              key={item.track.id}
              copilot={copilot}
              fit={contentFit}
              names={names}
            />
          )}
        </div>
        {copilot && item.kind === 'screen' && !item.self && (
          <CopilotViewerSlot
            copilot={copilot}
            peerId={shareIdOf(item.key)}
            track={item.track}
            viewport={viewport}
          />
        )}
      </div>
      <div className="stage-bottomline">
        <span>{zoom > 1 ? 'Drag to move · scroll to zoom' : 'Scroll or pinch to zoom'}</span>
        <div>
          <button aria-label={`Zoom out ${item.name}`} onClick={() => step(-0.1)}>
            <ZoomOut size={16} />
          </button>
          <button onClick={reset} aria-label={`Reset zoom ${item.name}`}>
            {Math.round(zoom * 100)}%
          </button>
          <button
            aria-label={
              contentFit === 'fit' ? 'Fill available space' : 'Fit entire shared screen'
            }
            onClick={() => {
              onToggleFit();
              reset();
            }}
          >
            {contentFit === 'fit' ? 'Fit' : 'Fill'}
          </button>
          <button aria-label={`Zoom in ${item.name}`} onClick={() => step(0.1)}>
            <ZoomIn size={16} />
          </button>
          <span />
          <button aria-label="Fullscreen shared content" onClick={onFullscreen}>
            <Maximize2 size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}
