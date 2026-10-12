import { useEffectEvent, useRef, useState } from 'react';
import { Play, Pause, RefreshCw, ExternalLink } from 'lucide-react';
import { api, type Room, type User } from '@/api';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { watchPosition, type WatchTogetherState } from './activityApi';
import {
  connectYouTubeBridge,
  youtubeError,
  youtubeHostAction,
  youtubeLocalPlaybackChange,
  shouldApplyYouTubePlayback,
  type YouTubePlayerEvent,
  type YouTubePlayback,
} from './youtubeBridge';
import type { ActivityAction } from './PollsPanel';
import { youtubeRequiresBrowser } from './youtubePlatform';
import { YouTubeBrowserRequired } from './YouTubeBrowserRequired';

type PlayerProps = {
  room: Room;
  user: User;
  state: WatchTogetherState;
  receivedAt: number;
  joined: boolean;
  act: ActivityAction;
  busy: boolean;
};

const seekNavigationKeys = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export function YouTubeWatchPlayer(props: PlayerProps) {
  if (youtubeRequiresBrowser()) return <YouTubeBrowserRequired />;
  return <AvailableYouTubeWatchPlayer {...props} />;
}

function AvailableYouTubeWatchPlayer({
  room,
  user,
  state,
  receivedAt,
  joined,
  act,
  busy,
}: PlayerProps) {
  const [bootstrap, setBootstrap] = useState<{
    ticket: string;
    player_origin: string;
    nonce: string;
  }>();
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState('');
  const playerContainer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ReturnType<typeof connectYouTubeBridge> | undefined>(
    undefined,
  );
  const endedPlayback = useRef('');
  const lastApplied = useRef<YouTubePlayback | undefined>(undefined);
  const dragging = useRef(false);
  const lifetime = useLifetimeSignal();
  const canPost = room.permissions?.post ?? room.can_post ?? true;
  const host = state.host_id === user.id && canPost;
  const apply = (force = false) => {
    // Keep an official control gesture in place until its host mutation and
    // authoritative revision have reconciled, rather than immediately undoing it.
    if (host && busy && !force) return;
    const playback: YouTubePlayback = {
      position: watchPosition(state, receivedAt),
      paused: state.paused,
      enabled,
      volume,
      muted,
      force: force || lastApplied.current?.revision !== state.revision,
      revision: state.revision,
    };
    if (
      !bridge.current ||
      !shouldApplyYouTubePlayback(playback, lastApplied.current, host)
    )
      return;
    bridge.current.apply(playback);
    lastApplied.current = playback;
  };
  const synchronize = useEffectEvent(() => apply());
  const receive = useEffectEvent((event: YouTubePlayerEvent) => {
    switch (event.type) {
      case 'ready':
        setReady(true);
        setLoading(false);
        setError('');
        apply(true);
        break;
      case 'position':
        if (!dragging.current) setPosition(event.position);
        setDuration(event.duration);
        setBuffering(event.state === 3);
        break;
      case 'buffering':
        setBuffering(true);
        break;
      case 'autoplay-blocked':
        setEnabled(false);
        setError(
          'Click the official YouTube Play button to allow playback, then Resume synchronization.',
        );
        break;
      case 'error':
        bridge.current?.close();
        bridge.current = undefined;
        setBootstrap(undefined);
        setReady(false);
        setLoading(false);
        setEnabled(false);
        setError(youtubeError(event.code));
        break;
      case 'bootstrap-error':
        bridge.current?.close();
        bridge.current = undefined;
        setBootstrap(undefined);
        setReady(false);
        setEnabled(false);
        setLoading(false);
        setError(event.message);
        break;
      case 'user-state': {
        if (event.revision !== state.revision) break;
        setBuffering(false);
        const localPlayback = youtubeLocalPlaybackChange(event, host);
        if (localPlayback !== undefined) setEnabled(localPlayback);
        if (host && !busy) {
          const action = youtubeHostAction(event, {
            paused: state.paused,
            position: watchPosition(state, receivedAt),
            revision: state.revision,
          });
          if (action) void command(action, event.position);
        }
        break;
      }
      case 'ended':
        if (
          host &&
          joined &&
          state.playback_id &&
          endedPlayback.current !== state.playback_id
        ) {
          endedPlayback.current = state.playback_id;
          setEnabled(false);
          const playback = state.playback_id;
          const revision = state.revision;
          void api<{ revision: number }>(
            `/rooms/${room.id}/watch-together/queue`,
            undefined,
            undefined,
            lifetime(),
          )
            .then(async (queue) => {
              if (!lifetime().aborted)
                if (
                  !(await act(
                    '/watch-together/next',
                    {
                      playback_id: playback,
                      revision,
                      queue_revision: queue.revision,
                    },
                    'POST',
                  ))
                )
                  throw new Error('Queue advance was busy or changed.');
            })
            .catch(() => {
              if (!lifetime().aborted) {
                if (endedPlayback.current === playback)
                  endedPlayback.current = '';
                setError('Could not advance the queue. Use Skip to next.');
              }
            });
        }
        break;
    }
  });
  const frameLoaded = useEffectEvent((event: Event) => {
    const loadedFrame = frame.current;
    if (!bootstrap || event.target !== loadedFrame || !loadedFrame) return;
    bridge.current?.close();
    bridge.current = undefined;
    try {
      bridge.current = connectYouTubeBridge(
        loadedFrame,
        bootstrap.player_origin,
        bootstrap.ticket,
        bootstrap.nonce,
        receive,
      );
    } catch (failure) {
      setLoading(false);
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not connect the player.',
      );
    }
  });
  useMountEffect(() => {
    const container = playerContainer.current;
    // Capture the iframe's non-bubbling load event from a mount-scoped
    // external subscription. Effect Events read the latest committed ticket
    // and playback controls without being invoked by a React event handler.
    container?.addEventListener('load', frameLoaded, true);
    const timer = setInterval(() => synchronize(), 500);
    return () => {
      container?.removeEventListener('load', frameLoaded, true);
      clearInterval(timer);
      bridge.current?.close();
      bridge.current = undefined;
    };
  });
  async function allowYouTube() {
    if (!joined || loading) return;
    setLoading(true);
    setError('');
    bridge.current?.close();
    bridge.current = undefined;
    setReady(false);
    const signal = lifetime();
    try {
      const result = await api<{
        ticket: string;
        player_origin: string;
        nonce: string;
      }>(
        `/rooms/${room.id}/watch-together/player-ticket`,
        {
          playback_id: state.playback_id,
          nonce: crypto.randomUUID(),
          parent_origin: window.location.origin,
        },
        'POST',
        signal,
      );
      if (!signal.aborted) {
        setBootstrap(result);
        setEnabled(true);
      }
    } catch (failure) {
      if (!signal.aborted) {
        setLoading(false);
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not open YouTube.',
        );
      }
    }
  }
  async function command(action: string, seconds = position) {
    if (!host) return false;
    return act(
      '/watch-together?watch_sources=file,youtube',
      {
        action,
        revision: state.revision,
        playback_id: state.playback_id,
        position_seconds: Math.max(0, Math.min(604800, seconds)),
      },
      'PUT',
    );
  }
  function cancelSeek() {
    if (!dragging.current) return;
    dragging.current = false;
    apply(true);
  }
  return (
    <div ref={playerContainer} className="space-y-3 [&_button]:min-h-11">
      <div className="overflow-hidden rounded-xl border bg-black">
        {bootstrap ? (
          <iframe
            key={bootstrap.nonce}
            ref={frame}
            src={`${bootstrap.player_origin}/player${window.location.origin === 'null' ? '?opaque=1' : ''}`}
            title={`Watch together: ${state.youtube?.title ?? 'YouTube'}`}
            className="aspect-video min-h-[200px] max-h-[40dvh] w-full"
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="max-w-md text-sm text-white/80">
              Allow YouTube to load its player. YouTube receives your device and
              viewing information; BetterComms does not download the video.
            </p>
            <Button
              disabled={!joined || loading}
              onClick={() => void allowYouTube()}
            >
              <Play size={16} />
              {loading
                ? 'Opening YouTube…'
                : 'Allow YouTube and start playback'}
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!ready}
          onClick={() => {
            setEnabled(!enabled);
          }}
        >
          {enabled ? 'Pause on this device' : 'Resume synchronization'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!ready}
          onClick={() => apply(true)}
        >
          <RefreshCw size={14} />
          Sync now
        </Button>
        <span className="text-xs text-muted-foreground">
          {buffering
            ? 'Buffering on your device…'
            : host
              ? 'You control playback'
              : 'Host controls playback'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={muted}
            onChange={(event) => setMuted(event.target.checked)}
          />
          Mute video
        </label>
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-xs">
            Local volume {Math.round(volume * 100)}%
          </span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            className="min-h-11 min-w-0 flex-1"
            aria-label="YouTube local volume"
            onChange={(event) => setVolume(Number(event.target.value))}
          />
        </label>
      </div>
      {host && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            key={state.paused ? 'play' : 'pause'}
            size="sm"
            disabled={!ready || busy}
            onClick={() => void command(state.paused ? 'play' : 'pause')}
          >
            {state.paused ? <Play size={14} /> : <Pause size={14} />}
            {state.paused ? 'Play for everyone' : 'Pause for everyone'}
          </Button>
          <label className="order-last flex min-w-0 basis-full items-center gap-2 text-xs sm:order-none sm:flex-1 sm:basis-auto">
            <span className="shrink-0">Shared position</span>
            <input
              type="range"
              min="0"
              max={duration || 1}
              step="1"
              value={Math.min(position, duration || 1)}
              disabled={!ready || busy || !duration}
              className="min-h-11 min-w-0 flex-1"
              aria-label="YouTube shared position"
              onPointerDown={() => {
                dragging.current = true;
              }}
              onPointerUp={() => {
                if (!dragging.current) return;
                dragging.current = false;
                void command('seek', position);
              }}
              onPointerCancel={cancelSeek}
              onLostPointerCapture={cancelSeek}
              onBlur={cancelSeek}
              onKeyDown={(event) => {
                if (
                  seekNavigationKeys.has(event.key) &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey
                )
                  dragging.current = true;
              }}
              onKeyUp={(event) => {
                if (!seekNavigationKeys.has(event.key) || !dragging.current)
                  return;
                dragging.current = false;
                if (event.altKey || event.ctrlKey || event.metaKey) apply(true);
                else void command('seek', position);
              }}
              onChange={(event) => setPosition(Number(event.target.value))}
            />
          </label>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void command('stop')}
          >
            End session
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          <Button
            size="sm"
            variant="ghost"
            disabled={!joined || loading}
            onClick={() => void allowYouTube()}
          >
            Reopen player
          </Button>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {state.youtube?.title}. Videos and Shorts are supported. Ads,
        availability and playback restrictions can differ between viewers; live
        streams are not guaranteed.
      </p>
      <a
        className="inline-flex min-h-11 items-center gap-2 text-sm text-primary"
        href={`https://www.youtube.com/watch?v=${state.youtube?.id}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <ExternalLink size={14} />
        Open on YouTube
      </a>
    </div>
  );
}
