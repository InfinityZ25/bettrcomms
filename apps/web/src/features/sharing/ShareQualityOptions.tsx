import { ChevronDown } from 'lucide-react';
import type { NativeScreenCapabilities, NativeScreenStartOptions } from '@/media/nativeScreen';
import {
  bitratePresets,
  type BitrateChoice,
  type ContentChoice,
  type FpsChoice,
  type useShareOptions,
} from './useShareOptions';

/** Resolution, frame rate, content hint, cursor, and the advanced encoder block. */
export default function ShareQualityOptions({
  options,
  capabilities,
  encoder,
  onEncoder,
  busy,
  hasSelection,
}: {
  options: ReturnType<typeof useShareOptions>;
  capabilities: NativeScreenCapabilities | null;
  encoder: NativeScreenStartOptions['encoder'];
  onEncoder: (encoder: NativeScreenStartOptions['encoder']) => void;
  busy: boolean;
  hasSelection: boolean;
}) {
  return (
    <>
      <div className="share-quality-grid">
        <label>
          Resolution
          <select
            aria-label="Resolution"
            value={options.resolution}
            disabled={busy}
            onChange={(event) => options.setResolution(event.target.value)}
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
            value={options.fpsChoice}
            disabled={busy}
            onChange={(event) => options.setFpsChoice(event.target.value as FpsChoice)}
          >
            <option value="30">30 FPS</option>
            <option value="60">60 FPS</option>
            <option value="120">120 FPS</option>
            <option value="custom">Custom</option>
          </select>
          {options.fpsChoice === 'custom' && (
            <input
              aria-label="Custom frame rate"
              type="number"
              inputMode="numeric"
              min="15"
              max="240"
              step="1"
              value={options.customFps}
              disabled={busy}
              onChange={(event) => options.setCustomFps(event.target.value)}
            />
          )}
        </label>
      </div>
      <label>
        Content
        <select
          aria-label="Stream content"
          value={options.contentChoice}
          disabled={busy}
          onChange={(event) => options.setContentChoice(event.target.value as ContentChoice)}
        >
          <option value="auto">Automatic · detect source</option>
          <option value="motion">Gameplay · smooth motion</option>
          <option value="detail">Text &amp; desktop · fine detail</option>
        </select>
      </label>
      {hasSelection && options.exceedsCompatibility && (
        <p className="share-source-advice">
          {options.resolutionLabel} at {options.fps} FPS exceeds 1080p60 pixel throughput.
          Some compatibility viewers may receive fewer frames.
        </p>
      )}
      {!options.qualityValid && (
        <p className="share-error" role="alert">
          Enter a whole frame rate from 15 to 240 FPS and a whole bitrate from 1 to 200
          Mbps.
        </p>
      )}
      <label className="share-cursor">
        Include cursor
        <input
          type="checkbox"
          checked={options.cursor}
          disabled={busy}
          onChange={(event) => options.setCursor(event.target.checked)}
        />
      </label>
      <label className="share-cursor">
        Show capture border
        <input
          type="checkbox"
          aria-label="Show capture border"
          checked={options.displayBorder}
          disabled={busy}
          onChange={(event) => options.setDisplayBorder(event.target.checked)}
        />
      </label>
      <details className="share-advanced">
        <summary>
          Encoder &amp; bitrate
          <ChevronDown size={15} />
        </summary>
        <div>
          <label>
            Encoder
            <select
              aria-label="Encoder"
              value={encoder}
              disabled={busy}
              onChange={(event) =>
                onEncoder(event.target.value as NativeScreenStartOptions['encoder'])
              }
            >
              {capabilities?.encoders.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
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
              value={options.bitrateChoice}
              disabled={busy}
              onChange={(event) =>
                options.setBitrateChoice(event.target.value as BitrateChoice)
              }
            >
              {bitratePresets.map((value) => (
                <option value={value} key={value}>
                  {value} Mbps
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
            {options.bitrateChoice === 'custom' && (
              <input
                aria-label="Custom bitrate"
                type="number"
                inputMode="numeric"
                min="1"
                max="200"
                step="1"
                value={options.customBitrate}
                disabled={busy}
                onChange={(event) => options.setCustomBitrate(event.target.value)}
              />
            )}
          </label>
          <label>
            Video compatibility
            <select
              aria-label="Video compatibility"
              value={options.h264Profile}
              disabled={busy}
              onChange={(event) =>
                options.setH264Profile(event.target.value as 'auto' | 'baseline')
              }
            >
              <option value="auto">Automatic · best shared profile</option>
              <option value="baseline">Compatibility · H.264 Baseline</option>
            </select>
          </label>
          <p>
            Automatic selects the best H.264 profile supported by everyone currently in
            the call. Bitrate applies to each viewer and your native recording.
          </p>
          <p>
            Custom range: 15–240 FPS and 1–200 Mbps. Delivered FPS can be lower when the
            source, encoder, GPU, receiver, or network cannot sustain the request.
          </p>
        </div>
      </details>
    </>
  );
}
