import { Check, Monitor, PanelsTopLeft, RefreshCw, Search } from 'lucide-react';
import SourcePreview from './SourcePreview';
import type { PreviewCache } from './previewQueue';
import type { NativeScreenSource } from '@/media/nativeScreen';

const CATEGORY_LABELS: Record<string, string> = {
  game: ' · Game / graphics',
  browser: ' · Browser',
  utility: ' · Utility',
};

/** The window and monitor chooser: tabs, search, and the previewed grid. */
export default function SourcePicker({
  tab,
  onTab,
  query,
  onQuery,
  visible,
  sourceId,
  onSelect,
  busy,
  refreshing,
  onRefresh,
  previewCache,
  previewRevision,
}: {
  tab: 'window' | 'monitor';
  onTab: (tab: 'window' | 'monitor') => void;
  query: string;
  onQuery: (query: string) => void;
  visible: NativeScreenSource[];
  sourceId: string;
  onSelect: (id: string) => void;
  busy: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  previewCache: PreviewCache;
  previewRevision: number;
}) {
  return (
    <section className="share-source-panel" aria-label="Capture sources">
      <div className="share-source-toolbar">
        <div className="share-source-tabs">
          <button aria-pressed={tab === 'window'} onClick={() => onTab('window')}>
            <PanelsTopLeft size={17} />
            Applications
          </button>
          <button aria-pressed={tab === 'monitor'} onClick={() => onTab('monitor')}>
            <Monitor size={17} />
            Entire screen
          </button>
        </div>
        <button
          className="share-refresh"
          aria-label="Refresh sources"
          title="Refresh sources"
          disabled={refreshing || busy}
          onClick={onRefresh}
        >
          <RefreshCw size={17} className={refreshing ? 'is-spinning' : ''} />
        </button>
      </div>
      <label className="share-search">
        <Search size={16} />
        <input
          type="search"
          aria-label="Find a source"
          placeholder="Find a window…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        <span>{visible.length} sources</span>
      </label>
      <div
        className="share-source-scroll"
        aria-label="Available sources"
        tabIndex={0}
        aria-busy={refreshing}
      >
        <div className="share-source-grid">
          {visible.map((source) => (
            <button
              key={source.id}
              className={`share-source-card${sourceId === source.id ? ' is-selected' : ''}`}
              aria-label={source.name}
              aria-pressed={sourceId === source.id}
              title={source.name}
              disabled={busy}
              onClick={() => onSelect(source.id)}
            >
              <SourcePreview
                source={source}
                cache={previewCache}
                revision={previewRevision}
              />
              {sourceId === source.id && (
                <span className="share-selected-check">
                  <Check size={15} />
                </span>
              )}
              <span className="share-source-caption">
                {source.kind === 'monitor' ? (
                  <Monitor size={17} />
                ) : (
                  <PanelsTopLeft size={17} />
                )}
                <span>
                  <strong>{source.name}</strong>
                  <small>
                    {source.width} × {source.height}
                    {CATEGORY_LABELS[source.category ?? ''] ?? ''}
                    {source.minimized ? ' · Minimized' : ''}
                  </small>
                </span>
              </span>
            </button>
          ))}
        </div>
        {!visible.length && (
          <div className="share-source-empty">
            <PanelsTopLeft size={32} />
            <strong>
              {refreshing
                ? 'Finding your sources…'
                : query
                  ? 'No matching sources'
                  : 'No sources available'}
            </strong>
            <p>
              {query
                ? 'Try a different name.'
                : 'Open a window, then refresh the sources.'}
            </p>
          </div>
        )}
      </div>
      <p className="share-privacy-note">
        Previews stay on this device. Nothing is shared until you choose Share.
      </p>
    </section>
  );
}
