import { Volume2 } from 'lucide-react';
import type { NativeSystemAudioCapabilities } from '@/media/nativeSystemAudio';
import type { useShareOptions } from './useShareOptions';

const explain = (
  caps: NativeSystemAudioCapabilities | null,
  applicationAudio: boolean,
  excludeCallAudio: boolean,
) => {
  if (!caps?.available) return caps?.detail ?? 'Checking system audio support…';
  if (applicationAudio)
    return caps.applicationAudio
      ? 'Sound from this application and its child processes. Windows sharing the same process may share audio.'
      : 'Update the desktop app for application audio, or explicitly select System audio above.';
  return excludeCallAudio
    ? 'Share other apps’ sound while excluding BetterComms playback.'
    : 'All system sound, including the call. Other people may hear themselves.';
};

/** What sound travels with the capture, and the escape hatch to browser sharing. */
export default function ShareAudioOptions({
  options,
  audioCaps,
  showScope,
  busy,
  onUseBrowser,
}: {
  options: ReturnType<typeof useShareOptions>;
  audioCaps: NativeSystemAudioCapabilities | null;
  showScope: boolean;
  busy: boolean;
  onUseBrowser: () => void;
}) {
  const { applicationAudio, audioAvailable, systemAudio, excludeCallAudio } = options;
  const shareLabel = applicationAudio ? 'Share application audio' : 'Share system audio';
  return (
    <div className="share-audio-note">
      <Volume2 size={17} />
      <div>
        {showScope && (
          <label>
            Audio source
            <select
              aria-label="Audio source"
              value={options.audioScope}
              disabled={busy}
              onChange={(event) =>
                options.setAudioScope(event.target.value as 'application' | 'system')
              }
            >
              <option value="application">Selected application</option>
              <option value="system">System audio</option>
            </select>
          </label>
        )}
        <label className="share-cursor">
          {shareLabel}
          <input
            type="checkbox"
            aria-label={shareLabel}
            checked={systemAudio && audioAvailable}
            disabled={busy || !audioAvailable}
            onChange={(event) => options.setSystemAudio(event.target.checked)}
          />
        </label>
        {!applicationAudio && (
          <label className="share-cursor">
            Exclude call audio
            <input
              type="checkbox"
              aria-label="Exclude call audio"
              checked={excludeCallAudio}
              disabled={busy || !systemAudio || !audioCaps?.callAudioControl}
              onChange={(event) => options.setExcludeCallAudio(event.target.checked)}
            />
          </label>
        )}
        <p>{explain(audioCaps, applicationAudio, excludeCallAudio)}</p>
        {!applicationAudio && audioCaps?.available && !audioCaps.callAudioControl && (
          <p>Update the desktop app for improved call-audio exclusion and this control.</p>
        )}
        <button disabled={busy} onClick={onUseBrowser}>
          Use browser sharing
        </button>
      </div>
    </div>
  );
}
