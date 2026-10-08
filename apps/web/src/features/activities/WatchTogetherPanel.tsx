import { useEffectEvent, useRef, useState } from 'react';
import {
  Film,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  Square,
} from 'lucide-react';
import {
  api,
  type MessageAttachment,
  type Room,
  type RoomMember,
  type User,
} from '@/api';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { signedAttachmentURL } from '@/features/chat/attachmentFiles';
import { watchPosition, type WatchTogetherState } from './activityApi';
import type { ActivityAction } from './PollsPanel';

function timeLabel(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function SynchronizedVideo({
  room,
  user,
  state,
  receivedAt,
  act,
  busy,
}: {
  room: Room;
  user: User;
  state: WatchTogetherState;
  receivedAt: number;
  act: ActivityAction;
  busy: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const enabled = useRef(false);
  const dragging = useRef(false);
  const lastAppliedRevision = useRef<number | null>(null);
  const [playbackEnabled, setPlaybackEnabled] = useState(false);
  const [url, setURL] = useState('');
  const [error, setError] = useState('');
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [nextHost, setNextHost] = useState('');
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);
  const lifetime = useLifetimeSignal();
  const owns = state.host_id === user.id;
  async function loadURL() {
    const signal = lifetime();
    setError('');
    try {
      const value = await signedAttachmentURL(
        room.id,
        state.attachment.id,
        signal,
      );
      if (!signal.aborted) setURL(value);
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not open this video.',
        );
    }
  }
  function synchronize(force = false) {
    const element = video.current;
    if (!element || !element.readyState || dragging.current) return;
    const current = { state, receivedAt };
    const target = Math.min(
      Number.isFinite(element.duration) ? element.duration : 604800,
      watchPosition(current.state, current.receivedAt),
    );
    if (
      force ||
      lastAppliedRevision.current !== current.state.revision ||
      Math.abs(element.currentTime - target) > 0.75
    )
      element.currentTime = target;
    lastAppliedRevision.current = current.state.revision;
    if (!enabled.current || current.state.paused) element.pause();
    else if (element.paused && !element.ended)
      void element.play().catch(() => {
        if (lifetime().aborted) return;
        enabled.current = false;
        setPlaybackEnabled(false);
        setError(
          'Start playback to allow this browser to play the shared video.',
        );
      });
    setPosition(target);
  }
  const synchronizePlayback = useEffectEvent(() => synchronize());
  const readWatchState = useEffectEvent(() => state);
  useMountEffect(() => {
    void loadURL();
    const signal = lifetime();
    void api<{ members: RoomMember[] }>(
      `/rooms/${room.id}/members`,
      undefined,
      undefined,
      signal,
    ).then(
      (result) => {
        if (!signal.aborted) setMembers(result.members);
      },
      () => {},
    );
    const timer = setInterval(() => synchronizePlayback(), 500);
    let heartbeatPending = false;
    const heartbeat = setInterval(() => {
      const current = readWatchState();
      if (current.host_id !== user.id || heartbeatPending || signal.aborted)
        return;
      heartbeatPending = true;
      void api(
        `/rooms/${room.id}/watch-together`,
        {
          action: 'heartbeat',
          revision: current.revision,
          position_seconds: 0,
        },
        'PUT',
        signal,
      )
        .catch(() => {})
        .finally(() => {
          heartbeatPending = false;
        });
    }, 15000);
    const renew = setInterval(() => {
      void loadURL();
    }, 4 * 60000);
    return () => {
      clearInterval(timer);
      clearInterval(heartbeat);
      clearInterval(renew);
      const element = video.current;
      if (element) {
        element.pause();
        element.removeAttribute('src');
        element.load();
      }
    };
  });
  async function command(
    action: string,
    seconds = video.current?.currentTime ?? watchPosition(state, receivedAt),
    hostId?: string,
  ) {
    return act(
      '/watch-together',
      {
        action,
        revision: state.revision,
        position_seconds: Math.min(604800, Math.max(0, seconds)),
        ...(hostId ? { host_id: hostId } : {}),
      },
      'PUT',
    );
  }
  function allowPlayback() {
    enabled.current = true;
    setPlaybackEnabled(true);
    setError('');
    const element = video.current;
    if (element && !state.paused)
      void element.play().catch(() => {
        if (lifetime().aborted) return;
        enabled.current = false;
        setPlaybackEnabled(false);
        setError(
          'This browser blocked video playback. Try Start playback again.',
        );
      });
    synchronize(true);
  }
  async function seek() {
    dragging.current = false;
    await command('seek', position);
  }
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border bg-black">
        <video
          ref={video}
          src={url || undefined}
          playsInline
          preload="metadata"
          className="aspect-video max-h-[40dvh] w-full object-contain"
          aria-label={`Watch together: ${state.attachment.filename}`}
          onLoadedMetadata={(event) => {
            event.currentTarget.volume = volume;
            event.currentTarget.muted = muted;
            const value = event.currentTarget.duration;
            if (Number.isFinite(value)) setDuration(value);
            synchronize(true);
          }}
          onError={() =>
            setError(
              'The video link expired or its format cannot play in this browser. Refresh the video link.',
            )
          }
          onEnded={() => {
            if (owns && !state.paused && !busy)
              void command('pause', video.current?.duration ?? position);
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={playbackEnabled ? 'secondary' : 'default'}
          size="sm"
          onClick={() => {
            if (playbackEnabled) {
              enabled.current = false;
              setPlaybackEnabled(false);
              video.current?.pause();
            } else allowPlayback();
          }}
        >
          <Play size={14} />
          {playbackEnabled ? 'Playback enabled' : 'Start playback'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => synchronize(true)}>
          <RefreshCw size={14} />
          Sync now
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {owns ? 'You control playback' : 'Host controls playback'} ·{' '}
          {state.paused ? 'Paused' : 'Playing'}
        </span>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={muted}
            onChange={(event) => {
              setMuted(event.target.checked);
              if (video.current) video.current.muted = event.target.checked;
            }}
          />
          Mute video
        </label>
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">
            Local volume {Math.round(volume * 100)}%
          </span>
          <input
            className="min-w-0 flex-1 accent-primary"
            type="range"
            aria-label="Shared video local volume"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={(event) => {
              const value = Number(event.target.value);
              setVolume(value);
              if (video.current) video.current.volume = value;
            }}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-12 text-xs tabular-nums text-muted-foreground">
          {timeLabel(position)}
        </span>
        <input
          aria-label="Shared video position"
          type="range"
          min="0"
          max={duration || 1}
          step="0.1"
          value={Math.min(position, duration || 1)}
          disabled={!owns || busy || !duration}
          className="min-w-0 flex-1 accent-primary"
          onPointerDown={() => {
            dragging.current = true;
          }}
          onPointerUp={() => void seek()}
          onPointerCancel={() => {
            dragging.current = false;
            synchronize(true);
          }}
          onKeyDown={() => {
            dragging.current = true;
          }}
          onKeyUp={() => void seek()}
          onChange={(event) => setPosition(Number(event.target.value))}
        />
        <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
          {timeLabel(duration)}
        </span>
      </div>
      {owns && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !duration}
            aria-label="Skip back 10 seconds for everyone"
            onClick={() => void command('seek', Math.max(0, position - 10))}
          >
            <SkipBack size={14} />
          </Button>
          <Button
            size="sm"
            disabled={busy || !duration}
            onClick={() => {
              if (state.paused) allowPlayback();
              void command(state.paused ? 'play' : 'pause');
            }}
          >
            {state.paused ? <Play size={14} /> : <Pause size={14} />}
            {state.paused ? 'Play for everyone' : 'Pause for everyone'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !duration}
            aria-label="Skip forward 10 seconds for everyone"
            onClick={() =>
              void command('seek', Math.min(duration, position + 10))
            }
          >
            <SkipForward size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void command('stop', 0)}
          >
            <Square size={14} />
            End session
          </Button>
        </div>
      )}
      {owns && members.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor="watch-host">
            Hand playback to
          </label>
          <select
            id="watch-host"
            value={nextHost}
            onChange={(event) => setNextHost(event.target.value)}
            className="min-h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
            disabled={busy}
          >
            <option value="">Choose a member</option>
            {members
              .filter((member) => member.user.id !== user.id)
              .map((member) => (
                <option key={member.user.id} value={member.user.id}>
                  {member.user.name}
                </option>
              ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !nextHost}
            onClick={() => void command('transfer', 0, nextHost)}
          >
            Transfer control
          </Button>
        </div>
      )}
      {!owns && state.can_claim && (
        <Button
          size="sm"
          variant="outline"
          disabled={
            busy || !room.permissions?.post || !room.permissions?.join_voice
          }
          onClick={() => void command('claim', 0)}
        >
          Take over playback
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          <Button size="sm" variant="ghost" onClick={() => void loadURL()}>
            Refresh video link
          </Button>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {state.attachment.filename}. Each viewer starts playback explicitly.
        Your local volume and pause do not change the shared position.
      </p>
    </div>
  );
}

export function WatchTogetherPanel({
  room,
  user,
  state,
  receivedAt,
  busy,
  act,
}: {
  room: Room;
  user: User;
  state: WatchTogetherState | null;
  receivedAt: number;
  busy: boolean;
  act: ActivityAction;
}) {
  const [videos, setVideos] = useState<MessageAttachment[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState('');
  const [error, setError] = useState('');
  const lifetime = useLifetimeSignal();
  async function load(more = false) {
    const signal = lifetime();
    setLoading(true);
    setError('');
    try {
      const result = await api<{
        files: MessageAttachment[];
        next_cursor?: string;
      }>(
        `/rooms/${room.id}/files?type=video&limit=50${more && cursor ? `&cursor=${cursor}` : ''}`,
        undefined,
        undefined,
        signal,
      );
      if (!signal.aborted) {
        setVideos((previous) =>
          more
            ? [
                ...previous,
                ...result.files.filter(
                  (file) => !previous.some((old) => old.id === file.id),
                ),
              ]
            : result.files,
        );
        setCursor(result.next_cursor ?? '');
      }
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not load channel videos.',
        );
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }
  useMountEffect(() => {
    void load();
  });
  const canHost =
    (room.permissions?.post ?? room.can_post ?? true) &&
    (room.permissions?.join_voice ?? room.can_join_voice ?? true);
  return (
    <div className="space-y-4">
      {state && (
        <SynchronizedVideo
          key={state.attachment.id}
          room={room}
          user={user}
          state={state}
          receivedAt={receivedAt}
          act={act}
          busy={busy}
        />
      )}
      {(!state || state.host_id === user.id) && canHost && (
        <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
          <label className="block text-sm font-medium">
            Choose a video from this channel
            <select
              className="mt-2 min-h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={busy || loading}
            >
              <option value="">
                {loading ? 'Loading videos…' : 'Select a shared video'}
              </option>
              {videos.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.filename}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!selected || busy || loading}
              onClick={() =>
                void act(
                  '/watch-together',
                  {
                    action: 'start',
                    attachment_id: selected,
                    revision: state?.revision ?? 0,
                    position_seconds: 0,
                  },
                  'PUT',
                )
              }
            >
              <Film size={15} />
              {state ? 'Change video' : 'Watch together'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => void load()}
            >
              Refresh videos
            </Button>
            {cursor && (
              <Button
                size="sm"
                variant="ghost"
                disabled={loading}
                onClick={() => void load(true)}
              >
                More videos
              </Button>
            )}
          </div>
        </div>
      )}
      {!state && (
        <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Film size={26} />
          <p className="max-w-sm text-sm">
            Watch a video already shared in this channel. Play, pause and seek
            together, with one host keeping everyone in sync.
          </p>
        </div>
      )}
      {!loading && !videos.length && canHost && (
        <p className="text-sm text-muted-foreground">
          Send a video in chat first, then refresh this list.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
