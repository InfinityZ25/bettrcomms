import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Monitor,
  MonitorUp,
  PanelsTopLeft,
  RefreshCw,
  Search,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  NativeScreenCapabilities,
  NativeScreenSource,
  NativeScreenStartOptions,
} from '@/media/nativeScreen';
import './NativeScreenPicker.css';
import NativeFfmpegSetup from './NativeFfmpegSetup';
import type { NativeSystemAudioCapabilities } from '@/media/nativeSystemAudio';

const previewQueue: Array<() => Promise<void>> = [];
let activePreviews = 0;
function pumpPreviews() {
  while (activePreviews < 2 && previewQueue.length) {
    const next = previewQueue.shift()!;
    activePreviews++;
    void next().finally(() => {
      activePreviews--;
      pumpPreviews();
    });
  }
}
function thumbnailBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(data);
  if (data && typeof data === 'object') {
    const wrapped = (data as { data?: unknown }).data;
    if (Array.isArray(wrapped)) return new Uint8Array(wrapped);
  }
  throw new Error('Native preview returned an unsupported image format');
}
type PreviewCache = Map<string, { blob: Blob; at: number }>;
function SourcePreview({
  source,
  cache,
  revision,
}: {
  source: NativeScreenSource;
  cache: PreviewCache;
  revision: number;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState('');
  const [failure, setFailure] = useState('');
  useEffect(() => {
    let alive = true,
      queued = false,
      started = false,
      objectUrl = '';
    setFailure('');
    setUrl('');
    const request = async () => {
      if (!alive) return;
      started = true;
      try {
        const data = await invoke<unknown>('native_screen_thumbnail', {
          sourceId: source.id,
        });
        if (!alive) return;
        const bytes = thumbnailBytes(data);
        if (
          bytes.length < 4 ||
          bytes[0] !== 0xff ||
          bytes[1] !== 0xd8 ||
          bytes.at(-2) !== 0xff ||
          bytes.at(-1) !== 0xd9
        )
          throw new Error('Native preview returned an incomplete JPEG');
        const blob = new Blob([Uint8Array.from(bytes).buffer], {
          type: 'image/jpeg',
        });
        cache.delete(source.id);
        cache.set(source.id, { blob, at: Date.now() });
        while (
          cache.size > 32 ||
          [...cache.values()].reduce((sum, entry) => sum + entry.blob.size, 0) >
            8 * 1024 * 1024
        )
          cache.delete(cache.keys().next().value!);
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setFailure('');
        return;
      } catch (cause) {
        if (alive)
          setFailure(cause instanceof Error ? cause.message : String(cause));
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (started) return;
        if (!entries.some((entry) => entry.isIntersecting)) {
          const index = previewQueue.indexOf(request);
          if (index >= 0) previewQueue.splice(index, 1);
          queued = false;
          return;
        }
        if (queued) return;
        const cached = cache.get(source.id);
        if (cached && Date.now() - cached.at < 30_000) {
          objectUrl = URL.createObjectURL(cached.blob);
          setUrl(objectUrl);
          observer.disconnect();
          return;
        }
        cache.delete(source.id);
        queued = true;
        previewQueue.push(request);
        pumpPreviews();
      },
      {
        root: element.current?.closest('.share-source-scroll'),
        rootMargin: '0px',
      },
    );
    if (element.current) observer.observe(element.current);
    return () => {
      alive = false;
      observer.disconnect();
      const index = previewQueue.indexOf(request);
      if (index >= 0) previewQueue.splice(index, 1);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source.id, cache, revision]);
  return (
    <span ref={element} className="share-source-preview">
      {url ? (
        <img
          src={url}
          alt=""
          onError={() => {
            setUrl('');
            setFailure('The native preview image could not be displayed');
          }}
        />
      ) : (
        <span className="share-preview-placeholder">
          {source.kind === 'monitor' ? (
            <Monitor size={30} />
          ) : (
            <PanelsTopLeft size={30} />
          )}
          <small title={failure}>
            {failure
              ? source.minimized
                ? 'Minimized · restore the app for a preview'
                : 'Preview unavailable · refresh sources above'
              : 'Loading preview…'}
          </small>
        </span>
      )}
    </span>
  );
}

export default function NativeScreenPicker({
  onShare,
  onBrowser,
  onClose,
}: {
  onShare(options: NativeScreenStartOptions): Promise<void>;
  onBrowser(): Promise<void>;
  onClose(): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const alive = useRef(true);
  const generation = useRef(0);
  const previewCache = useRef<PreviewCache>(new Map());
  const [previewRevision, setPreviewRevision] = useState(0);
  const [capabilities, setCapabilities] =
    useState<NativeScreenCapabilities | null>(null);
  const [sources, setSources] = useState<NativeScreenSource[]>([]);
  const [tab, setTab] = useState<'window' | 'monitor'>('window');
  const [query, setQuery] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [encoder, setEncoder] =
    useState<NativeScreenStartOptions['encoder']>('libx264');
  const [resolution, setResolution] = useState('source');
  const [contentChoice, setContentChoice] =
    useState<'auto' | 'motion' | 'detail'>('auto');
  const [fpsChoice, setFpsChoice] =
    useState<'30' | '60' | '120' | 'custom'>('60');
  const [customFps, setCustomFps] = useState('144');
  const [bitrateChoice, setBitrateChoice] =
    useState<'8' | '10' | '12' | '16' | '20' | '40' | '80' | 'custom'>('20');
  const [customBitrate, setCustomBitrate] = useState('20');
  const [h264Profile, setH264Profile] = useState<'auto' | 'baseline'>('auto');
  const [cursor, setCursor] = useState(true);
  const [displayBorder, setDisplayBorder] = useState(
    () => localStorage.getItem('bc-capture-border') === 'true',
  );
  const [systemAudio, setSystemAudio] = useState(true);
  const [excludeCallAudio, setExcludeCallAudio] = useState(true);
  const [audioScope, setAudioScope] = useState<'application' | 'system'>('application');
  const [audioCaps, setAudioCaps] =
    useState<NativeSystemAudioCapabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState('');
  async function refreshSources(resetPreviews = false) {
    const current = ++generation.current;
    setRefreshing(true);
    setError('');
    try {
      const result = await invoke<{ sources: NativeScreenSource[] }>(
        'native_screen_sources',
      );
      if (!alive.current || current !== generation.current) return;
      if (resetPreviews) {
        previewCache.current.clear();
        setPreviewRevision((value) => value + 1);
      }
      setSources(result.sources);
      setSourceId((id) =>
        result.sources.some((source) => source.id === id) ? id : '',
      );
    } catch (cause) {
      if (alive.current && current === generation.current)
        setError(String(cause));
    } finally {
      if (alive.current && current === generation.current) setRefreshing(false);
    }
  }
  async function refreshCapabilities() {
    const caps = await invoke<NativeScreenCapabilities>('native_screen_capabilities');
    if (!alive.current) return;
    setCapabilities(caps);
    setEncoder(caps.encoders.find((item) => item.available)?.id ?? 'libx264');
    setError('');
  }
  useEffect(() => {
    alive.current = true;
    let current = true;
    void invoke<NativeSystemAudioCapabilities>(
      'native_system_audio_capabilities',
    )
      .then((caps) => {
        if (current) setAudioCaps(caps);
      })
      .catch(() => {
        if (current)
          setAudioCaps({
            available: false,
            detail: 'System audio is unavailable in this desktop build.',
          });
      });
    void refreshSources();
    void refreshCapabilities()
      .catch((cause) => {
        if (current) setError(String(cause));
      });
    heading.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      alive.current = false;
      current = false;
      generation.current++;
      document.removeEventListener('keydown', keydown);
    };
  }, []);
  const visible = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.kind === tab &&
          source.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [sources, tab, query],
  );
  const selected = sources.find((source) => source.id === sourceId);
  const fps = Number(fpsChoice === 'custom' ? customFps : fpsChoice);
  const bitrateMbps = Number(
    bitrateChoice === 'custom' ? customBitrate : bitrateChoice,
  );
  const qualityValid =
    Number.isInteger(fps) &&
    fps >= 15 &&
    fps <= 240 &&
    Number.isInteger(bitrateMbps) &&
    bitrateMbps >= 1 &&
    bitrateMbps <= 200;
  const applicationAudio = (selected?.kind ?? tab) === 'window' && audioScope === 'application';
  const audioAvailable = audioCaps?.available === true && (!applicationAudio || audioCaps.applicationAudio === true);
  const resolutionLabel = resolution === 'source' && selected
    ? `Match source (${selected.width}×${selected.height})`
    : resolution === 'source'
      ? 'Match source'
      : resolution.toUpperCase();
  const requestedPixels = resolution === 'source' && selected
    ? selected.width * selected.height
    : resolution === '720p' ? 1280 * 720
      : resolution === '1080p' ? 1920 * 1080
        : resolution === '1440p' ? 2560 * 1440
          : 3840 * 2160;
  async function start(browser = false) {
    setBusy(true);
    setError('');
    try {
      if (browser) await onBrowser();
      else {
        if (!qualityValid) {
          throw new Error('Choose 15–240 whole FPS and 1–200 whole Mbps');
        }
        const dimensions =
          resolution === '720p'
            ? [1280, 720]
            : resolution === '1080p'
            ? [1920, 1080]
            : resolution === '1440p'
              ? [2560, 1440]
              : resolution === '4k'
                ? [3840, 2160]
                : [0, 0];
        await onShare({
          sourceId,
          encoder,
          width: dimensions[0],
          height: dimensions[1],
          fps,
          bitrateMbps,
          contentHint: contentChoice === 'auto'
            ? selected?.category === 'game' ? 'motion' : 'detail'
            : contentChoice,
          h264Profile,
          cursor,
          displayBorder,
          systemAudio: systemAudio && audioAvailable,
          ...(systemAudio && audioAvailable && applicationAudio ? { systemAudioSourceId: sourceId } : {}),
          excludeCallAudio: applicationAudio || excludeCallAudio,
        });
      }
    } catch (cause) {
      if (alive.current) setError(String(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <main className="share-screen" aria-label="Share your screen">
      <header className="share-screen-header">
        <Button variant="ghost" onClick={onClose}>
          <ArrowLeft size={16} />
          Back to call
        </Button>
        <span className="share-call-status">
          <i />
          Your call stays connected
        </span>
      </header>
      <div className="share-screen-intro">
        <div>
          <span className="share-eyebrow">BRING THEM INTO YOUR WORLD</span>
          <h1 ref={heading} tabIndex={-1}>
            Share your screen
          </h1>
          <p>A game, a project, a little of your day. Choose what they see.</p>
        </div>
        <MonitorUp size={36} />
      </div>
      <div className="share-screen-body">
        <section className="share-source-panel" aria-label="Capture sources">
          <div className="share-source-toolbar">
            <div className="share-source-tabs">
              <button
                aria-pressed={tab === 'window'}
                onClick={() => {
                  setTab('window');
                  setQuery('');
                }}
              >
                <PanelsTopLeft size={17} />
                Applications
              </button>
              <button
                aria-pressed={tab === 'monitor'}
                onClick={() => {
                  setTab('monitor');
                  setQuery('');
                }}
              >
                <Monitor size={17} />
                Entire screen
              </button>
            </div>
            <button
              className="share-refresh"
              aria-label="Refresh sources"
              title="Refresh sources"
              disabled={refreshing || busy}
              onClick={() => void refreshSources(true)}
            >
              <RefreshCw
                size={17}
                className={refreshing ? 'is-spinning' : ''}
              />
            </button>
          </div>
          <label className="share-search">
            <Search size={16} />
            <input
              type="search"
              aria-label="Find a source"
              placeholder="Find a window…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
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
                  onClick={() => setSourceId(source.id)}
                >
                  <SourcePreview
                    source={source}
                    cache={previewCache.current}
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
                        {source.category === 'game'
                          ? ' · Game / graphics'
                          : source.category === 'browser'
                            ? ' · Browser'
                            : source.category === 'utility'
                              ? ' · Utility'
                              : ''}
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
            Previews stay on this device. Nothing is shared until you choose
            Share.
          </p>
        </section>
        <aside className="share-setup" aria-label="Stream setup">
          <div>
            <span className="share-eyebrow">MAKE IT YOURS</span>
            <h2>Stream setup</h2>
          </div>
          <div className="share-selection">
            <MonitorUp size={21} />
            <span>
              <small>{selected ? 'Ready to share' : 'Select a source'}</small>
              <strong title={selected?.name}>
                {selected?.name ?? 'Your stage is waiting'}
              </strong>
            </span>
          </div>
          {selected?.minimized && (
            <p className="share-source-advice">
              Sharing restores this minimized app. If exclusive fullscreen stays
              blank, use borderless mode or share your entire screen.
            </p>
          )}
          <div className="share-quality-grid">
            <label>
              Resolution
              <select
                aria-label="Resolution"
                value={resolution}
                disabled={busy}
                onChange={(e) => setResolution(e.target.value)}
              >
                <option value="source">Match source</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="1440p">1440p</option>
                <option value="4k">4K</option>
              </select>
            </label>
            <label>
              Frame rate
              <select
                aria-label="Frame rate"
                value={fpsChoice}
                disabled={busy}
                onChange={(event) =>
                  setFpsChoice(event.target.value as typeof fpsChoice)
                }
              >
                <option value="30">30 FPS</option>
                <option value="60">60 FPS</option>
                <option value="120">120 FPS</option>
                <option value="custom">Custom</option>
              </select>
              {fpsChoice === 'custom' && (
                <input
                  aria-label="Custom frame rate"
                  type="number"
                  inputMode="numeric"
                  min="15"
                  max="240"
                  step="1"
                  value={customFps}
                  disabled={busy}
                  onChange={(event) => setCustomFps(event.target.value)}
                />
              )}
            </label>
          </div>
          <label>
            Content
            <select
              aria-label="Stream content"
              value={contentChoice}
              disabled={busy}
              onChange={(event) =>
                setContentChoice(event.target.value as typeof contentChoice)
              }
            >
              <option value="auto">Automatic · detect source</option>
              <option value="motion">Gameplay · smooth motion</option>
              <option value="detail">Text & desktop · fine detail</option>
            </select>
          </label>
          {selected && requestedPixels * fps > 1920 * 1080 * 60 && (
            <p className="share-source-advice">
              {resolutionLabel} at {fps} FPS exceeds 1080p60 pixel throughput.
              Some compatibility viewers may receive fewer frames.
            </p>
          )}
          {!qualityValid && (
            <p className="share-error" role="alert">
              Enter a whole frame rate from 15 to 240 FPS and a whole bitrate
              from 1 to 200 Mbps.
            </p>
          )}
          <label className="share-cursor">
            Include cursor
            <input
              type="checkbox"
              checked={cursor}
              disabled={busy}
              onChange={(e) => setCursor(e.target.checked)}
            />
          </label>
          <label className="share-cursor">
            Show capture border
            <input
              type="checkbox"
              aria-label="Show capture border"
              checked={displayBorder}
              disabled={busy}
              onChange={(event) => {
                setDisplayBorder(event.target.checked);
                localStorage.setItem(
                  'bc-capture-border',
                  String(event.target.checked),
                );
              }}
            />
          </label>
          <details className="share-advanced">
            <summary>
              Encoder & bitrate
              <ChevronDown size={15} />
            </summary>
            <div>
              <label>
                Encoder
                <select
                  aria-label="Encoder"
                  value={encoder}
                  disabled={busy}
                  onChange={(e) =>
                    setEncoder(
                      e.target.value as NativeScreenStartOptions['encoder'],
                    )
                  }
                >
                  {capabilities?.encoders.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={!item.available}
                    >
                      {item.label}
                      {item.available ? '' : ` · ${item.reason}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Bitrate
                <select
                  aria-label="Bitrate"
                  value={bitrateChoice}
                  disabled={busy}
                  onChange={(event) =>
                    setBitrateChoice(event.target.value as typeof bitrateChoice)
                  }
                >
                  {[8, 10, 12, 16, 20, 40, 80].map((n) => (
                    <option value={n} key={n}>
                      {n} Mbps
                    </option>
                  ))}
                  <option value="custom">Custom</option>
                </select>
                {bitrateChoice === 'custom' && (
                  <input
                    aria-label="Custom bitrate"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="200"
                    step="1"
                    value={customBitrate}
                    disabled={busy}
                    onChange={(event) => setCustomBitrate(event.target.value)}
                  />
                )}
              </label>
              <label>
                Video compatibility
                <select
                  aria-label="Video compatibility"
                  value={h264Profile}
                  disabled={busy}
                  onChange={(e) =>
                    setH264Profile(e.target.value as 'auto' | 'baseline')
                  }
                >
                  <option value="auto">Automatic · best shared profile</option>
                  <option value="baseline">
                    Compatibility · H.264 Baseline
                  </option>
                </select>
              </label>
              <p>
                Automatic selects the best H.264 profile supported by everyone
                currently in the call. Bitrate applies to each viewer and your
                native recording.
              </p>
              <p>
                Custom range: 15–240 FPS and 1–200 Mbps. Delivered FPS can be
                lower when the source, encoder, GPU, receiver, or network cannot
                sustain the request.
              </p>
            </div>
          </details>
          <div className="share-audio-note">
            <Volume2 size={17} />
            <div>
              {(selected?.kind ?? tab) === 'window' && <label>
                Audio source
                <select aria-label="Audio source" value={audioScope} disabled={busy} onChange={event => setAudioScope(event.target.value as 'application' | 'system')}>
                  <option value="application">Selected application</option>
                  <option value="system">System audio</option>
                </select>
              </label>}
              <label className="share-cursor">
                {applicationAudio ? 'Share application audio' : 'Share system audio'}
                <input
                  type="checkbox"
                  aria-label={applicationAudio ? 'Share application audio' : 'Share system audio'}
                  checked={systemAudio && audioAvailable}
                  disabled={busy || !audioAvailable}
                  onChange={(event) => setSystemAudio(event.target.checked)}
                />
              </label>
              {!applicationAudio && <label className="share-cursor">
                Exclude call audio
                <input type="checkbox" aria-label="Exclude call audio" checked={excludeCallAudio}
                  disabled={busy || !systemAudio || !audioCaps?.callAudioControl}
                  onChange={event => setExcludeCallAudio(event.target.checked)} />
              </label>}
              <p>
                {audioCaps?.available
                  ? applicationAudio
                    ? audioCaps.applicationAudio
                      ? 'Sound from this application and its child processes. Windows sharing the same process may share audio.'
                      : 'Update the desktop app for application audio, or explicitly select System audio above.'
                    : excludeCallAudio
                      ? 'Share other apps’ sound while excluding BetterComms playback.'
                      : 'All system sound, including the call. Other people may hear themselves.'
                  : (audioCaps?.detail ?? 'Checking system audio support…')}
              </p>
              {!applicationAudio && audioCaps?.available && !audioCaps.callAudioControl &&
                <p>Update the desktop app for improved call-audio exclusion and this control.</p>}
              <button disabled={busy} onClick={() => void start(true)}>
                Use browser sharing
              </button>
            </div>
          </div>
          {capabilities && !capabilities.available && (
            <>
              <p className="share-error">{capabilities.detail}</p>
              <NativeFfmpegSetup
                onInstalled={async () => {
                  await Promise.all([refreshCapabilities(), refreshSources(true)]);
                }}
                onUseBrowser={() => start(true)}
              />
            </>
          )}
          {!capabilities && error.toLowerCase().includes('ffmpeg') && (
            <NativeFfmpegSetup
              onInstalled={async () => {
                await Promise.all([refreshCapabilities(), refreshSources(true)]);
              }}
              onUseBrowser={() => start(true)}
            />
          )}
          {error && (
            <p className="share-error" role="alert">
              {error}
            </p>
          )}
        </aside>
      </div>
      <footer className="share-screen-footer">
        <div>
          <strong>
            {selected
              ? 'One click and you’re sharing.'
              : 'What would you like to share?'}
          </strong>
          <small>
            {selected
              ? qualityValid
                ? `${resolutionLabel} · ${fps} FPS · ${bitrateMbps} Mbps`
                : 'Finish the custom quality settings'
              : 'Choose an application or your entire screen.'}
          </small>
        </div>
        <div className="share-footer-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!capabilities?.available || !selected || busy || !qualityValid}
            onClick={() => void start()}
          >
            <MonitorUp size={17} />
            {busy ? 'Starting…' : 'Share'}
          </Button>
        </div>
      </footer>
    </main>
  );
}
