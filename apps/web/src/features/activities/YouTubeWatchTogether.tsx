import {
  useEffectEvent,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  ListVideo,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';
import {
  api,
  ApiRequestError,
  type Room,
  type RoomMember,
  type User,
} from '@/api';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import type { ActivityAction } from './PollsPanel';
import type {
  WatchPlaylist,
  WatchQueueSnapshot,
  WatchTogetherState,
  YouTubeVideo,
} from './activityApi';
import { subscribeActivityEvents } from './activityEvents';
import { YouTubeWatchPlayer } from './YouTubeWatchPlayer';
import { keepWatchPresence } from './watchHeartbeat';
import { youtubeRequiresBrowser } from './youtubePlatform';
import { YouTubeBrowserRequired } from './YouTubeBrowserRequired';

const emptyQueue: WatchQueueSnapshot = {
  items: [],
  revision: 1,
  viewers: 0,
  votes: 0,
  voted: false,
};
type WatchProps = {
  room: Room;
  user: User;
  state: WatchTogetherState | null;
  receivedAt: number;
  act: ActivityAction;
  busy: boolean;
};

export function YouTubeWatchTogether(props: WatchProps) {
  // Room permission changes release viewing without discarding account lists.
  const [playlists, setPlaylists] = useState<WatchPlaylist[]>([]);
  const canRead = props.room.permissions?.read ?? true;
  const canVoice =
    props.room.permissions?.join_voice ?? props.room.can_join_voice ?? true;
  return (
    <YouTubeWatchRoom
      key={`${canRead}:${canVoice}`}
      {...props}
      playlists={playlists}
      setPlaylists={setPlaylists}
    />
  );
}

function YouTubeWatchRoom({
  room,
  user,
  state,
  receivedAt,
  act,
  busy,
  playlists,
  setPlaylists,
}: WatchProps & {
  playlists: WatchPlaylist[];
  setPlaylists: Dispatch<SetStateAction<WatchPlaylist[]>>;
}) {
  const [configured, setConfigured] = useState(false);
  const [joined, setJoined] = useState(false);
  const [queue, setQueue] = useState(emptyQueue);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [url, setURL] = useState('');
  const [title, setTitle] = useState('');
  const [listName, setListName] = useState('');
  const [nextHost, setNextHost] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [device] = useState(() => crypto.randomUUID());
  const mutation = useRef<{ input: string; nonce: string } | undefined>(
    undefined,
  );
  const pendingPlaylist = useRef<{ id: string; nonce: string } | undefined>(
    undefined,
  );
  const lifetime = useLifetimeSignal();
  const readGeneration = useRef(0);
  const readRequest = useRef<AbortController | undefined>(undefined);
  const saveMutation = useRef<{ input: string; nonce: string } | undefined>(
    undefined,
  );
  const canPost = room.permissions?.post ?? room.can_post ?? true;
  const canVoice = room.permissions?.join_voice ?? room.can_join_voice ?? true;
  const browserRequired = youtubeRequiresBrowser();
  const canView = (room.permissions?.read ?? true) && canVoice;
  const host = state?.host_id === user.id && canPost;
  const blocked = busy || working;
  async function load() {
    const ownerSignal = lifetime();
    readRequest.current?.abort();
    const request = new AbortController();
    readRequest.current = request;
    const generation = ++readGeneration.current;
    const stop = () => request.abort();
    ownerSignal.addEventListener('abort', stop, { once: true });
    if (ownerSignal.aborted) request.abort();
    const signal = request.signal;
    try {
      const [nextQueue, lists] = await Promise.all([
        canView
          ? api<WatchQueueSnapshot>(
              `/rooms/${room.id}/watch-together/queue`,
              undefined,
              undefined,
              signal,
            )
          : Promise.resolve(emptyQueue),
        api<{ playlists: WatchPlaylist[] }>(
          '/me/watch-playlists',
          undefined,
          undefined,
          signal,
        ),
      ]);
      if (!signal.aborted && generation === readGeneration.current) {
        setQueue(nextQueue);
        setPlaylists(lists.playlists);
      }
    } catch (failure) {
      if (!signal.aborted && generation === readGeneration.current) {
        if (
          failure instanceof ApiRequestError &&
          [401, 403, 404].includes(failure.status)
        ) {
          setQueue(emptyQueue);
          setJoined(false);
          if (failure.status === 401) setPlaylists([]);
        }
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not load the watch queue.',
        );
      }
    } finally {
      request.abort();
      ownerSignal.removeEventListener('abort', stop);
      if (readRequest.current === request) readRequest.current = undefined;
    }
  }
  const reconcile = useEffectEvent(() => void load());
  const heartbeat = useEffectEvent(async () => {
    if (!joined) return;
    const signal = lifetime();
    const result = await keepWatchPresence(
      () =>
        api(
          `/rooms/${room.id}/watch-together/viewing`,
          { device_id: device, present: true },
          'PUT',
          signal,
        ),
      state?.source_kind === 'youtube' && host && canPost
        ? () =>
            api(
              `/rooms/${room.id}/watch-together?watch_sources=file,youtube`,
              {
                action: 'heartbeat',
                revision: state.revision,
                playback_id: state.playback_id,
                position_seconds: 0,
              },
              'PUT',
              signal,
            )
        : undefined,
    );
    if (signal.aborted) return;
    if (result === 'revoked') {
      setJoined(false);
      setQueue(emptyQueue);
      setError('Watch membership changed. Join again to continue.');
    } else if (result === 'changed') void load();
    else if (result === 'interrupted')
      setError(
        'Connection interrupted. Watch membership will reconnect automatically.',
      );
  });
  useMountEffect(() => {
    const signal = lifetime();
    void api<{ watch_together?: { youtube_enabled: boolean } }>(
      '/config',
      undefined,
      undefined,
      signal,
    ).then(
      (result) => {
        if (!signal.aborted)
          setConfigured(result.watch_together?.youtube_enabled === true);
      },
      () => {},
    );
    if (canView)
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
    void load();
    const timer = setInterval(() => reconcile(), 10000);
    const presence = setInterval(() => {
      void heartbeat();
    }, 15000);
    const off = subscribeActivityEvents((event) => {
      if (event.room_id === room.id) reconcile();
    });
    return () => {
      readGeneration.current++;
      readRequest.current?.abort();
      readRequest.current = undefined;
      clearInterval(timer);
      clearInterval(presence);
      off();
      void api(
        `/rooms/${room.id}/watch-together/viewing`,
        { device_id: device, present: false },
        'PUT',
      ).catch(() => {});
    };
  });
  async function run(operation: () => Promise<unknown>) {
    if (blocked) return;
    setWorking(true);
    setError('');
    try {
      await operation();
      if (!lifetime().aborted) await load();
    } catch (failure) {
      if (!lifetime().aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'This watch action did not finish.',
        );
    } finally {
      if (!lifetime().aborted) setWorking(false);
    }
  }
  async function joinWatch() {
    if (browserRequired) return;
    const present = !joined;
    await run(async () => {
      await api(
        `/rooms/${room.id}/watch-together/viewing`,
        { device_id: device, present },
        'PUT',
        lifetime(),
      );
      if (!lifetime().aborted) setJoined(present);
    });
  }
  async function enqueue() {
    const input = JSON.stringify([url.trim(), title.trim()]);
    if (mutation.current?.input !== input)
      mutation.current = { input, nonce: crypto.randomUUID() };
    await run(async () => {
      await api(
        `/rooms/${room.id}/watch-together/queue`,
        {
          video_url: url.trim(),
          title: title.trim(),
          client_nonce: mutation.current!.nonce,
          revision: queue.revision,
        },
        'POST',
        lifetime(),
      );
      if (!lifetime().aborted) {
        setURL('');
        setTitle('');
        mutation.current = undefined;
      }
    });
  }
  async function next() {
    await act(
      '/watch-together/next',
      {
        playback_id: state?.playback_id ?? '',
        revision: state?.revision ?? 0,
        queue_revision: queue.revision,
      },
      'POST',
    );
    await load();
  }
  async function remove(id: string) {
    await run(() =>
      api(
        `/rooms/${room.id}/watch-together/queue/${id}`,
        { revision: queue.revision },
        'DELETE',
        lifetime(),
      ),
    );
  }
  async function reorder(index: number, delta: number) {
    const ids = queue.items.map((item) => item.id);
    const target = index + delta;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await run(() =>
      api(
        `/rooms/${room.id}/watch-together/queue/order`,
        { ids, revision: queue.revision },
        'PUT',
        lifetime(),
      ),
    );
  }
  async function savePlaylist() {
    const videos = [
      ...(state?.youtube ? [state.youtube] : []),
      ...queue.items.map((item) => item.video),
    ];
    const input = JSON.stringify([listName.trim(), videos]);
    if (saveMutation.current?.input !== input)
      saveMutation.current = { input, nonce: crypto.randomUUID() };
    await run(async () => {
      if (videos.length > 100)
        throw new Error(
          'Save up to 100 videos. Remove one queued video first.',
        );
      await api(
        '/me/watch-playlists',
        {
          name: listName.trim(),
          videos,
          client_nonce: saveMutation.current!.nonce,
        },
        'POST',
        lifetime(),
      );
      if (!lifetime().aborted) {
        setListName('');
        saveMutation.current = undefined;
      }
    });
  }
  async function loadPlaylist(list: WatchPlaylist) {
    if (pendingPlaylist.current?.id !== list.id)
      pendingPlaylist.current = { id: list.id, nonce: crypto.randomUUID() };
    await run(async () => {
      await api(
        `/rooms/${room.id}/watch-together/queue/playlist`,
        {
          playlist_id: list.id,
          playlist_version: list.version,
          client_nonce: pendingPlaylist.current!.nonce,
          revision: queue.revision,
        },
        'POST',
        lifetime(),
      );
      pendingPlaylist.current = undefined;
    });
  }
  async function updatePlaylist(
    list: WatchPlaylist,
    name: string,
    videos: YouTubeVideo[],
  ) {
    await run(() =>
      api(
        `/me/watch-playlists/${list.id}`,
        { name, videos, version: list.version },
        'PUT',
        lifetime(),
      ),
    );
  }
  if (!configured && !browserRequired)
    return state?.source_kind === 'youtube' ? (
      <p role="alert" className="text-sm text-destructive">
        YouTube playback is temporarily unavailable. Reopen activities after the
        player service recovers.
      </p>
    ) : null;
  return (
    <section
      aria-label="YouTube watch queue"
      className="space-y-4 [&_button]:min-h-11 [&_button]:min-w-11"
    >
      {browserRequired && <YouTubeBrowserRequired />}
      {canView ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
            <span className="inline-flex items-center gap-2 text-sm">
              <Users size={16} />
              {queue.viewers} watching ·{' '}
              {joined
                ? 'You joined Watch'
                : 'Join without turning on your microphone'}
            </span>
            <Button
              size="sm"
              disabled={blocked || !canVoice || browserRequired}
              variant={joined ? 'secondary' : 'default'}
              onClick={() => void joinWatch()}
            >
              {joined ? 'Leave Watch' : 'Join Watch'}
            </Button>
          </div>
          {state?.source_kind === 'youtube' &&
            joined &&
            canVoice &&
            !browserRequired && (
              <YouTubeWatchPlayer
                key={state.playback_id}
                room={room}
                user={user}
                state={state}
                receivedAt={receivedAt}
                joined={joined}
                act={act}
                busy={blocked}
              />
            )}
          {joined && canPost && (
            <div className="space-y-2 rounded-xl border bg-muted/20 p-3">
              <label className="block text-sm font-medium">
                Add a YouTube video or Short
                <input
                  type="url"
                  className="mt-2 min-h-11 w-full rounded-md border bg-background px-3"
                  placeholder="https://www.youtube.com/watch?v=…"
                  value={url}
                  onChange={(event) => setURL(event.target.value)}
                  maxLength={2048}
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                Title (optional)
                <input
                  className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-sm"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={200}
                />
              </label>
              <Button
                size="sm"
                disabled={blocked || !url.trim() || queue.items.length >= 100}
                onClick={() => void enqueue()}
              >
                <Plus size={14} />
                Add to queue
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="inline-flex items-center gap-2 text-sm font-medium">
              <ListVideo size={16} />
              Up next · {queue.items.length}/100
            </h3>
            {joined && canPost && (!state || host) && (
              <Button
                size="sm"
                disabled={blocked || !queue.items.length}
                onClick={() => void next()}
              >
                {state ? 'Skip to next' : 'Start queue'}
              </Button>
            )}
            {joined && state && (
              <Button
                size="sm"
                variant="outline"
                disabled={blocked || queue.voted}
                onClick={() =>
                  void act(
                    '/watch-together/skip-vote',
                    {
                      playback_id: state.playback_id,
                      revision: state.revision,
                    },
                    'POST',
                  ).then(() => load())
                }
              >
                Vote to skip · {queue.votes}/{Math.floor(queue.viewers / 2) + 1}
              </Button>
            )}
          </div>
          {!queue.items.length && (
            <p className="text-sm text-muted-foreground">
              Add videos together. The host controls playback; a majority of
              viewers can vote to skip.
            </p>
          )}
          <ol className="space-y-2">
            {queue.items.map((item, index) => (
              <li
                key={item.id}
                className="flex min-w-0 items-center gap-2 rounded-lg border p-2"
              >
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm">
                  {item.video.title}
                </span>
                {joined && host && (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${item.video.title} earlier`}
                      disabled={blocked || index === 0}
                      onClick={() => void reorder(index, -1)}
                    >
                      <ArrowUp size={14} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${item.video.title} later`}
                      disabled={blocked || index === queue.items.length - 1}
                      onClick={() => void reorder(index, 1)}
                    >
                      <ArrowDown size={14} />
                    </Button>
                  </>
                )}
                {joined && canPost && (host || item.author_id === user.id) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${item.video.title}`}
                    disabled={blocked}
                    onClick={() => void remove(item.id)}
                  >
                    <Trash2 size={14} />
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {state?.source_kind === 'youtube' && joined && host && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="min-w-0 flex-1 text-xs">
                Hand playback to
                <select
                  aria-label="YouTube next host"
                  value={nextHost}
                  onChange={(event) => setNextHost(event.target.value)}
                  className="mt-1 min-h-11 w-full rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">Choose a viewing member</option>
                  {members
                    .filter(
                      (member) =>
                        member.user.id !== user.id &&
                        queue.host_candidates?.includes(member.user.id),
                    )
                    .map((member) => (
                      <option key={member.user.id} value={member.user.id}>
                        {member.user.name}
                      </option>
                    ))}
                </select>
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={blocked || !nextHost}
                onClick={() =>
                  void act(
                    '/watch-together?watch_sources=file,youtube',
                    {
                      action: 'transfer',
                      host_id: nextHost,
                      revision: state.revision,
                      playback_id: state.playback_id,
                      position_seconds: 0,
                    },
                    'PUT',
                  )
                }
              >
                Transfer control
              </Button>
            </div>
          )}
          {state?.source_kind === 'youtube' &&
            joined &&
            !host &&
            state.can_claim &&
            canPost && (
              <Button
                size="sm"
                variant="outline"
                disabled={blocked}
                onClick={() =>
                  void act(
                    '/watch-together?watch_sources=file,youtube',
                    {
                      action: 'claim',
                      revision: state.revision,
                      playback_id: state.playback_id,
                      position_seconds: 0,
                    },
                    'PUT',
                  )
                }
              >
                Take over playback
              </Button>
            )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Watching in this channel is unavailable with your current permissions.
        </p>
      )}
      <div className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">Your private YouTube lists</h3>
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="Name for saved YouTube list"
            value={listName}
            onChange={(event) => setListName(event.target.value)}
            maxLength={100}
            placeholder="Movie night"
            className="min-h-11 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={
              blocked ||
              !canView ||
              !listName.trim() ||
              (!queue.items.length && !state?.youtube)
            }
            onClick={() => void savePlaylist()}
          >
            Save current + queue
          </Button>
        </div>
        {playlists.map((list) => (
          <details key={list.id} className="rounded-lg border p-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm">
              {list.name} · {list.videos.length} videos
            </summary>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={
                  !canView ||
                  !joined ||
                  !canPost ||
                  blocked ||
                  !list.videos.length
                }
                onClick={() => void loadPlaylist(list)}
              >
                Add list to queue
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={blocked}
                onClick={() =>
                  void run(() =>
                    api(
                      `/me/watch-playlists/${list.id}`,
                      { version: list.version },
                      'DELETE',
                      lifetime(),
                    ),
                  )
                }
              >
                Delete list
              </Button>
            </div>
            <label className="mt-3 block text-xs">
              List name
              <input
                defaultValue={list.name}
                key={`${list.id}:${list.version}`}
                maxLength={100}
                className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-sm"
                onBlur={(event) => {
                  if (
                    event.target.value.trim() &&
                    event.target.value.trim() !== list.name
                  )
                    void updatePlaylist(
                      list,
                      event.target.value.trim(),
                      list.videos,
                    );
                }}
              />
            </label>
            <ol className="mt-2 space-y-1">
              {list.videos.map((video, index) => (
                <li
                  key={`${video.id}:${index}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="min-w-0 flex-1 break-words">
                    {video.title}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${video.title} from list`}
                    disabled={blocked}
                    onClick={() =>
                      void updatePlaylist(
                        list,
                        list.name,
                        list.videos.filter((_, at) => at !== index),
                      )
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                </li>
              ))}
            </ol>
          </details>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </p>
      )}
    </section>
  );
}
