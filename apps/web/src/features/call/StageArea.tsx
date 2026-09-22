import { MonitorUp, Radio, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import StagePane from './StagePane';
import type { StageItem } from './stageItems';
import type { VisualCopilot } from '@/media/visualCopilot';

/** The main viewing area: whatever is on stage, or the invitation to share. */
export default function StageArea({
  items,
  copilot,
  names,
  contentFit,
  focused,
  connectedCount,
  busy,
  onFocusItem,
  onRemoveItem,
  onToggleFit,
  onFullscreen,
  onShare,
}: {
  items: StageItem[];
  copilot?: VisualCopilot;
  names: Record<string, string>;
  contentFit: 'fit' | 'fill';
  focused: boolean;
  connectedCount: number;
  busy: boolean;
  onFocusItem: (key: string) => void;
  onRemoveItem: (item: StageItem) => void;
  onToggleFit: () => void;
  onFullscreen: () => void;
  onShare: () => void;
}) {
  const hasContent = items.length > 0;
  return (
    <div
      className={'content-stage ' + (hasContent ? 'has-share' : '')}
      data-content-fit={contentFit}
    >
      {hasContent ? (
        <>
          <div className="content-grid">
            {items.map((item) => (
              <StagePane
                key={item.key}
                copilot={copilot}
                names={names}
                item={item}
                contentFit={contentFit}
                canFocus={!focused && items.length > 1}
                onFocus={() => onFocusItem(item.key)}
                onRemove={() => onRemoveItem(item)}
                onToggleFit={onToggleFit}
                onFullscreen={onFullscreen}
              />
            ))}
          </div>
          <span className="content-security">
            <ShieldCheck size={14} /> {connectedCount} connected · encrypted media
          </span>
        </>
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
          <Button onClick={onShare} variant="secondary" disabled={busy}>
            <MonitorUp size={17} /> Share your screen
          </Button>
        </div>
      )}
    </div>
  );
}
