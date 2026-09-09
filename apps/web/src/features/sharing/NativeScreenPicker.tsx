import { useRef, useState } from 'react';
import { ArrowLeft, MonitorUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import NativeFfmpegSetup from './NativeFfmpegSetup';
import ShareAudioOptions from './ShareAudioOptions';
import ShareQualityOptions from './ShareQualityOptions';
import SourcePicker from './SourcePicker';
import { useNativeScreenSources } from './useNativeScreenSources';
import { useShareOptions } from './useShareOptions';
import type { NativeScreenStartOptions } from '@/media/nativeScreen';
import { useMountEffect } from '@/hooks/useMountEffect';
import './NativeScreenPicker.css';

/**
 * The full-screen source chooser for native desktop capture: pick a window or
 * monitor on the left, tune how it is encoded on the right. The call stays
 * connected the whole time, and nothing is captured until Share is pressed.
 */
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
  const [busy, setBusy] = useState(false);
  const sources = useNativeScreenSources(onClose);
  const options = useShareOptions({
    selected: sources.selected,
    tab: sources.tab,
    audioCaps: sources.audioCaps,
  });

  useMountEffect(() => {
    heading.current?.focus({ preventScroll: true });
  });

  async function start(browser = false) {
    setBusy(true);
    sources.setError('');
    try {
      if (browser) await onBrowser();
      else {
        if (!options.qualityValid)
          throw new Error('Choose 15–240 whole FPS and 1–200 whole Mbps');
        await onShare(options.buildOptions(sources.sourceId, sources.encoder));
      }
    } catch (cause) {
      if (sources.alive.current) sources.setError(String(cause));
    } finally {
      if (sources.alive.current) setBusy(false);
    }
  }

  const reloadNative = async () => {
    await Promise.all([sources.refreshCapabilities(), sources.refreshSources(true)]);
  };
  const ffmpegSetup = (
    <NativeFfmpegSetup onInstalled={reloadNative} onUseBrowser={() => start(true)} />
  );
  const { selected, capabilities } = sources;

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
        <SourcePicker
          tab={sources.tab}
          onTab={sources.chooseTab}
          query={sources.query}
          onQuery={sources.setQuery}
          visible={sources.visible}
          sourceId={sources.sourceId}
          onSelect={sources.setSourceId}
          busy={busy}
          refreshing={sources.refreshing}
          onRefresh={() => void sources.refreshSources(true)}
          previewCache={sources.previewCache.current}
          previewRevision={sources.previewRevision}
        />
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
              Sharing restores this minimized app. If exclusive fullscreen stays blank, use
              borderless mode or share your entire screen.
            </p>
          )}
          <ShareQualityOptions
            options={options}
            capabilities={capabilities}
            encoder={sources.encoder}
            onEncoder={sources.setEncoder}
            busy={busy}
            hasSelection={Boolean(selected)}
          />
          <ShareAudioOptions
            options={options}
            audioCaps={sources.audioCaps}
            showScope={(selected?.kind ?? sources.tab) === 'window'}
            busy={busy}
            onUseBrowser={() => void start(true)}
          />
          {capabilities && !capabilities.available && (
            <>
              <p className="share-error">{capabilities.detail}</p>
              {ffmpegSetup}
            </>
          )}
          {!capabilities && sources.error.toLowerCase().includes('ffmpeg') && ffmpegSetup}
          {sources.error && (
            <p className="share-error" role="alert">
              {sources.error}
            </p>
          )}
        </aside>
      </div>
      <footer className="share-screen-footer">
        <div>
          <strong>
            {selected ? 'One click and you’re sharing.' : 'What would you like to share?'}
          </strong>
          <small>
            {selected
              ? options.qualityValid
                ? `${options.resolutionLabel} · ${options.fps} FPS · ${options.bitrateMbps} Mbps`
                : 'Finish the custom quality settings'
              : 'Choose an application or your entire screen.'}
          </small>
        </div>
        <div className="share-footer-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!capabilities?.available || !selected || busy || !options.qualityValid}
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
