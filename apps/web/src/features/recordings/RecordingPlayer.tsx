import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Maximize2,
  Minimize2,
  Monitor,
  Pause,
  Play,
  SlidersHorizontal,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { RecordingResult, RecordingTrackManifest } from '@/media/types';
import './RecordingPlayer.css';
import { followElementOutput } from '@/media/output';

export interface RecordingPlayerProps {
  result: RecordingResult;
  labels?: Record<string, string>;
}

type PlayableTrack = RecordingTrackManifest & { url: string };

const formatTime = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

const trackLabel = (
  track: RecordingTrackManifest,
  labels?: Record<string, string>,
) => {
  const owner = labels?.[track.peerId] ?? track.peerId;
  const source = track.source === 'system' ? 'system audio' : track.source;
  return `${owner} · ${source}`;
};

export function RecordingPlayer({ result, labels }: RecordingPlayerProps) {
  const playerRef = useRef<HTMLElement>(null);
  const [tracks, setTracks] = useState<PlayableTrack[]>([]);

  useEffect(() => {
    const files = new Map(result.files.map((file) => [file.name, file.blob]));
    const nextTracks = result.manifest.tracks.flatMap((track) => {
      const blob = files.get(track.fileName);
      return (track.status === 'complete' || track.status === 'error') &&
        blob &&
        blob.size > 0
        ? [{ ...track, url: URL.createObjectURL(blob) }]
        : [];
    });
    setTracks(nextTracks);
    return () => nextTracks.forEach(({ url }) => URL.revokeObjectURL(url));
  }, [result]);

  const durationMs = useMemo(
    () =>
      Math.max(
        0,
        ...tracks.map((track) => track.startedOffsetMs + track.durationMs),
      ),
    [tracks],
  );
  const videoTracks = tracks.filter((track) => track.mediaKind === 'video');
  const audioTracks = tracks.filter((track) => track.mediaKind === 'audio');
  const [selectedVideoId, setSelectedVideoId] = useState(
    videoTracks[0]?.id ?? '',
  );
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [mixerVisible, setMixerVisible] = useState(true);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const mediaRefs = useRef(new Map<string, HTMLMediaElement>());
  const mediaRefCallbacks = useRef(
    new Map<
      string,
      (element: HTMLMediaElement | null) => void | (() => void)
    >(),
  );
  const clockRef = useRef({ startedAt: 0, offsetMs: 0 });
  const currentRef = useRef(0);

  useEffect(() => {
    if (!videoTracks.some((track) => track.id === selectedVideoId)) {
      setSelectedVideoId(videoTracks[0]?.id ?? '');
    }
  }, [selectedVideoId, videoTracks]);

  useEffect(() => {
    currentRef.current = currentMs;
  }, [currentMs]);

  const reportError = useCallback(
    (track: PlayableTrack, detail?: string) => {
      mediaRefs.current.forEach((element) => element.pause());
      setError(
        `Could not play ${trackLabel(track, labels)}${detail ? `: ${detail}` : '.'}`,
      );
      setPlaying(false);
    },
    [labels],
  );

  const recoverWebmDuration = (
    track: PlayableTrack,
    element: HTMLMediaElement,
  ) => {
    if (Number.isFinite(element.duration)) return;
    const restore = Math.max(
      0,
      (currentRef.current - track.startedOffsetMs) / 1000,
    );
    element.currentTime = 1e10;
    element.addEventListener(
      'timeupdate',
      () => {
        element.currentTime = restore;
      },
      { once: true },
    );
  };

  const positionTrack = useCallback(
    (
      track: PlayableTrack,
      wallMs: number,
      shouldPlay: boolean,
      forceSeek = false,
    ) => {
      const element = mediaRefs.current.get(track.id);
      if (!element) return;
      const localMs = wallMs - track.startedOffsetMs;
      const active = localMs >= 0 && localMs < track.durationMs;
      if (!active) {
        element.pause();
        if (localMs < 0 && element.currentTime > 0.05) element.currentTime = 0;
        return;
      }
      const target = localMs / 1000;
      if (forceSeek || Math.abs(element.currentTime - target) > 0.2)
        element.currentTime = target;
      if (shouldPlay && element.paused) {
        void element.play().catch((reason: unknown) => {
          reportError(
            track,
            reason instanceof Error ? reason.message : 'playback was blocked',
          );
        });
      } else if (!shouldPlay) {
        element.pause();
      }
    },
    [reportError],
  );

  const positionAll = useCallback(
    (wallMs: number, shouldPlay: boolean, forceSeek = false) => {
      tracks.forEach((track) =>
        positionTrack(track, wallMs, shouldPlay, forceSeek),
      );
    },
    [positionTrack, tracks],
  );

  useEffect(() => {
    if (!playing) return;
    let lastUiUpdate = 0;
    const tick = () => {
      const now = performance.now();
      const next = Math.min(
        durationMs,
        clockRef.current.offsetMs + now - clockRef.current.startedAt,
      );
      currentRef.current = next;
      positionAll(next, true);
      if (now - lastUiUpdate >= 100 || next >= durationMs) {
        setCurrentMs(next);
        lastUiUpdate = now;
      }
      if (next >= durationMs) {
        setPlaying(false);
        positionAll(durationMs, false);
      }
    };
    tick();
    const timer = window.setInterval(tick, 50);
    return () => window.clearInterval(timer);
  }, [durationMs, playing, positionAll]);

  useEffect(
    () => () => {
      mediaRefs.current.forEach((element) => element.pause());
      mediaRefCallbacks.current.clear();
    },
    [],
  );

  useEffect(() => {
    const updateFullscreen = () =>
      setFullscreen(document.fullscreenElement === playerRef.current);
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () =>
      document.removeEventListener('fullscreenchange', updateFullscreen);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    setError(null);
    try {
      if (document.fullscreenElement === playerRef.current) {
        await document.exitFullscreen();
      } else if (playerRef.current?.requestFullscreen) {
        await playerRef.current.requestFullscreen();
      } else {
        throw new Error('Fullscreen playback is not supported in this window.');
      }
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : 'Could not open fullscreen playback.',
      );
    }
  }, []);

  const togglePlayback = () => {
    setError(null);
    if (playing) {
      const now = performance.now();
      const position = Math.min(
        durationMs,
        clockRef.current.offsetMs + now - clockRef.current.startedAt,
      );
      setCurrentMs(position);
      positionAll(position, false, true);
      setPlaying(false);
      return;
    }
    const startAt = currentRef.current >= durationMs ? 0 : currentRef.current;
    currentRef.current = startAt;
    setCurrentMs(startAt);
    clockRef.current = { startedAt: performance.now(), offsetMs: startAt };
    positionAll(startAt, true, true);
    setPlaying(true);
  };

  const seek = (wallMs: number) => {
    const next = Math.max(0, Math.min(durationMs, wallMs));
    currentRef.current = next;
    setCurrentMs(next);
    clockRef.current = { startedAt: performance.now(), offsetMs: next };
    positionAll(next, playing, true);
  };

  const bindMedia = (track: PlayableTrack) => {
    const refKey = `${track.id}:${track.url}`;
    let callback = mediaRefCallbacks.current.get(refKey);
    if (!callback) {
      callback = (nextElement) => {
        if (!nextElement) return;
        if (nextElement.src !== track.url) {
          nextElement.src = track.url;
          nextElement.load();
        }
        const stopOutput =
          track.mediaKind === 'audio'
            ? followElementOutput(nextElement, (error) => {
                setError(error.message);
                setPlaying(false);
                nextElement.pause();
              })
            : () => {};
        mediaRefs.current.set(track.id, nextElement);
        return () => {
          stopOutput();
          nextElement.pause();
          nextElement.removeAttribute('src');
          nextElement.load();
          if (mediaRefs.current.get(track.id) === nextElement)
            mediaRefs.current.delete(track.id);
        };
      };
      mediaRefCallbacks.current.set(refKey, callback);
    }
    return callback;
  };

  const selectedVideo = videoTracks.find(
    (track) => track.id === selectedVideoId,
  );
  const selectedVideoActive = selectedVideo
    ? currentMs >= selectedVideo.startedOffsetMs &&
      currentMs < selectedVideo.startedOffsetMs + selectedVideo.durationMs
    : false;
  const warnings = result.manifest.tracks.filter(
    (track) => track.status !== 'complete',
  );

  return (
    <section
      className="recording-player"
      aria-label="Recording playback"
      ref={playerRef}
    >
      <div className="recording-player__transport">
        <button
          type="button"
          className="recording-player__play"
          onClick={togglePlayback}
          disabled={!tracks.length || durationMs === 0}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <Pause size={18} fill="currentColor" />
          ) : (
            <Play size={18} fill="currentColor" />
          )}
        </button>
        <span>{formatTime(currentMs)}</span>
        <input
          aria-label="Recording timeline"
          type="range"
          min="0"
          max={durationMs || 1}
          step="10"
          value={currentMs}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span>{formatTime(durationMs)}</span>
        <button
          type="button"
          className="recording-player__mixer-toggle"
          aria-label={mixerVisible ? 'Hide audio mixer' : 'Show audio mixer'}
          aria-pressed={mixerVisible}
          onClick={() => setMixerVisible((visible) => !visible)}
        >
          <SlidersHorizontal size={18} />
          <span>{mixerVisible ? 'Hide mixer' : 'Show mixer'}</span>
        </button>
        <button
          type="button"
          className="recording-player__fullscreen"
          aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          aria-pressed={fullscreen}
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          <span>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</span>
        </button>
      </div>
      <div
        className="recording-player__stage"
        onDoubleClick={(event) => {
          if (
            !(event.target as HTMLElement).closest(
              'button, input, select, label',
            )
          )
            void toggleFullscreen();
        }}
        title="Double-click video to toggle fullscreen"
      >
        {videoTracks.map((track) => (
          <video
            aria-label={trackLabel(track, labels)}
            className={
              track.id === selectedVideoId && selectedVideoActive
                ? 'recording-player__video is-visible'
                : 'recording-player__video'
            }
            key={track.id}
            muted
            playsInline
            preload="metadata"
            ref={bindMedia(track)}
            src={track.url}
            onError={() =>
              reportError(track, 'the media file could not be decoded')
            }
            onLoadedMetadata={(event) =>
              recoverWebmDuration(track, event.currentTarget)
            }
          />
        ))}
        {!selectedVideoActive && (
          <div className="recording-player__empty">
            <Monitor aria-hidden="true" size={30} />
            <strong>
              {videoTracks.length ? 'Video resumes later' : 'Audio recording'}
            </strong>
            <span>
              {videoTracks.length
                ? 'This source was not active at this point.'
                : 'No video sources were recorded.'}
            </span>
          </div>
        )}
        {videoTracks.length > 1 && (
          <label className="recording-player__source">
            <span>Video source</span>
            <select
              value={selectedVideoId}
              onChange={(event) => setSelectedVideoId(event.target.value)}
            >
              {videoTracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {trackLabel(track, labels)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div
        className={`recording-player__mixer${mixerVisible ? '' : ' is-hidden'}`}
      >
        {audioTracks.map((track) => {
          const volume = volumes[track.id] ?? 1;
          const isMuted = muted[track.id] ?? false;
          const active =
            currentMs >= track.startedOffsetMs &&
            currentMs < track.startedOffsetMs + track.durationMs;
          return (
            <div
              className={`recording-player__track${active ? ' is-active' : ''}`}
              key={track.id}
            >
              <audio
                preload="metadata"
                ref={bindMedia(track)}
                src={track.url}
                muted={isMuted}
                onError={() =>
                  reportError(track, 'the media file could not be decoded')
                }
                onLoadedMetadata={(event) =>
                  recoverWebmDuration(track, event.currentTarget)
                }
              />
              <button
                type="button"
                className="recording-player__mute"
                aria-label={`${isMuted ? 'Unmute' : 'Mute'} ${trackLabel(track, labels)}`}
                onClick={() =>
                  setMuted((values) => ({ ...values, [track.id]: !isMuted }))
                }
              >
                {isMuted || volume === 0 ? (
                  <VolumeX size={17} />
                ) : (
                  <Volume2 size={17} />
                )}
              </button>
              <div className="recording-player__track-name">
                <strong>{trackLabel(track, labels)}</strong>
                <span>
                  {active
                    ? playing
                      ? 'Playing'
                      : currentMs === 0
                        ? 'Ready'
                        : 'Paused'
                    : currentMs < track.startedOffsetMs
                      ? `Starts at ${formatTime(track.startedOffsetMs)}`
                      : 'Ended'}
                </span>
              </div>
              <input
                aria-label={`Volume for ${trackLabel(track, labels)}`}
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setVolumes((values) => ({ ...values, [track.id]: next }));
                  const element = mediaRefs.current.get(track.id);
                  if (element) element.volume = next;
                }}
              />
              <span className="recording-player__volume-value">
                {Math.round(volume * 100)}%
              </span>
            </div>
          );
        })}
      </div>

      {warnings.length > 0 && (
        <div className="recording-player__warnings" role="status">
          {warnings.map((track) => (
            <p key={track.id}>
              <strong>{trackLabel(track, labels)}</strong>:{' '}
              {track.error ??
                (track.status === 'empty'
                  ? 'No media was captured.'
                  : track.status === 'unsupported'
                    ? 'This source could not be recorded.'
                    : 'The recording ended with an error; retained media will still be played when possible.')}
            </p>
          ))}
        </div>
      )}
      {error && (
        <div className="recording-player__error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
