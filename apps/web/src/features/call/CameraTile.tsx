import type { CSSProperties } from 'react';
import { Headphones, Mic, MicOff, MonitorUp, Pin, Volume2 } from 'lucide-react';
import TrackVideo from './TrackVideo';
import FrozenTrackPreview from './FrozenTrackPreview';
import { PeerVolume } from './PeerAudio';
import { leadingInitials } from '@/components/avatar';
import type { RemoteTrack } from '@/media';
import type { ScreenShare } from './stageItems';

const DEGRADED_HINT =
  'The direct native connection failed, so this screen is being re-encoded through the call at reduced quality.';

const placeholder =
  'inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-muted text-xl font-semibold text-muted-foreground';

/** One participant in the camera strip: their video, or their initials. */
export function CameraTile({
  name,
  caption,
  track,
  self,
  speaking,
  featured,
  muted,
  deafened,
  aspect,
  canFocus,
  focusLabel,
  focusPressed,
  onFocus,
  onAspectRatio,
  connection,
  volume,
}: {
  name: string;
  caption: string;
  track?: MediaStreamTrack;
  self?: boolean;
  speaking: boolean;
  featured: boolean;
  muted?: boolean;
  deafened?: boolean;
  aspect: number;
  canFocus: boolean;
  focusLabel: string;
  focusPressed: boolean;
  onFocus(): void;
  onAspectRatio(ratio: number): void;
  /** Peers only: whether media is flowing yet. */
  connection?: 'connected' | 'connecting';
  /** Peers only: the per-participant volume control. */
  volume?: { peerId: string; remote: RemoteTrack[]; balanced: boolean };
}) {
  return (
    <div
      className={
        'camera-tile' +
        (self ? ' self' : '') +
        (speaking ? ' is-speaking' : '') +
        (featured ? ' is-featured' : '')
      }
      data-speaking={speaking}
      style={{ '--media-aspect': aspect } as CSSProperties}
    >
      {track && canFocus && (
        <button
          className="camera-focus-button"
          aria-label={focusLabel}
          aria-pressed={focusPressed}
          onClick={onFocus}
        >
          <Pin size={14} />
        </button>
      )}
      {speaking && (
        <span className="speaking-label">{self ? 'Microphone active' : 'Speaking'}</span>
      )}
      {track ? (
        <TrackVideo track={track} self={self} onAspectRatio={onAspectRatio} />
      ) : (
        <span className={placeholder}>{leadingInitials(name)}</span>
      )}
      <div className="tile-caption">
        <span>{caption}</span>
        {self ? (
          <>
            {muted ? <MicOff size={13} /> : <Mic size={13} />}
            {deafened && <Headphones size={13} aria-label="Deafened" />}
          </>
        ) : (
          <>
            {muted && <MicOff size={13} aria-label="Muted" />}
            {deafened && <Headphones size={13} aria-label="Deafened" />}
            <span className={connection === 'connected' ? 'online-dot' : 'connecting-dot'} />
          </>
        )}
      </div>
      {volume && (
        <details className="peer-volume">
          <summary aria-label="Adjust participant volume">
            <Volume2 size={14} />
          </summary>
          <PeerVolume {...volume} />
        </details>
      )}
    </div>
  );
}

/** A screen share shown alongside the cameras rather than on the stage. */
export function ScreenShareTile({
  share,
  watching,
  focused,
  onFocus,
  onToggleWatch,
}: {
  share: ScreenShare;
  watching: boolean;
  focused: boolean;
  onFocus(): void;
  onToggleWatch(): void;
}) {
  return (
    <div className="camera-tile screen-share-tile" data-watching={watching}>
      {watching ? (
        <TrackVideo track={share.track} />
      ) : (
        <FrozenTrackPreview track={share.track} name={share.name} />
      )}
      <button
        className="camera-focus-button"
        aria-label={`Focus ${share.name}`}
        aria-pressed={focused}
        onClick={onFocus}
      >
        <Pin size={14} />
      </button>
      <div className="screen-share-actions">
        <button
          aria-label={`${watching ? 'Stop watching' : 'Watch'} ${share.name}`}
          onClick={onToggleWatch}
        >
          <MonitorUp size={14} /> {watching ? 'Stop watching' : 'Watch'}
        </button>
      </div>
      <div className="tile-caption">
        <span>{share.name}</span>
        {share.reencoded && (
          <span className="screen-share-degraded" title={DEGRADED_HINT}>
            Reduced quality
          </span>
        )}
        <MonitorUp size={13} />
      </div>
    </div>
  );
}
