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
import { youtubeWatchURL } from './youtubeURL';
import { createWatchViewing } from './watchViewing';

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
  initialURL?: string;
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
  initialURL,
}: WatchProps & {
  playlists: WatchPlaylist[];
  setPlaylists: Dispatch<SetStateAction<WatchPlaylist[]>>;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [configurationFailed, setConfigurationFailed] = useState(false);
  const [joined, setJoined] = useState(false);
  const [queue, setQueue] = useState(emptyQueue);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [url, setURL] = useState(initialURL ?? '');
  const [title, setTitle] = useState('');
  const [listName, setListName] = useState('');
  const [nextHost, setNextHost] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const workingNow = useRef(false);
  const viewing = useRef<ReturnType<typeof createWatchViewing> | undefined>(
    undefined,
  );
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
    const current = viewing.current;
    if (!joined || !current) return;
    const signal = current.signal;
    const result = await keepWatchPresence(
      () => current.renew(),
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
    if (signal.aborted || !current.wantsPresence()) return;
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
  async function loadConfiguration() {
    const signal = lifetime();
    setConfigured(null);
    setConfigurationFailed(false);
    try {
      const result = await api<{
        watch_together?: { youtube_enabled: boolean };
      }>('/config', undefined, undefined, signal);
      if (!signal.aborted)
        setConfigured(result.watch_together?.youtube_enabled === true);
    } catch {
      if (!signal.aborted) {
        setConfigured(false);
        setConfigurationFailed(true);
      }
    }
  }
  useMountEffect(() => {
    const signal = lifetime();
    const device = crypto.randomUUID();
    const currentViewing = createWatchViewing(
      signal,
      (present, requestSignal) =>
        api(
          `/rooms/${room.id}/watch-together/viewing`,
          { device_id: device, present },
          'PUT',
          requestSignal,
        ),
    );
    viewing.current = currentViewing;
    void loadConfiguration();
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
      currentViewing.close();
      if (viewing.current === currentViewing) viewing.current = undefined;
    };
  });
  async function run(operation: () => Promise<unknown>) {
    if (busy || workingNow.current || lifetime().aborted) return;
    workingNow.current = true;
    setWorking(true);
    setError('');
    try {
      await operation();
      if (!lifetime().aborted) await load();
    } catch (failure) {
      if (!lifetime().aborted) await load();
      if (!lifetime().aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'This watch action did not finish.',
        );
    } finally {
      workingNow.current = false;
      if (!lifetime().aborted) setWorking(false);
    }
  }
  async function joinWatch() {
    if (browserRequired) return;
    const present = !joined;
    await run(async () => {
      if (await viewing.current?.set(present)) setJoined(present);
    });
  }
  async function enqueue(start = false) {
    if (
      blocked ||
      workingNow.current ||
      !configured ||
      !canView ||
      !canPost ||
      browserRequired
    )
      return;
    const videoURL = youtubeWatchURL(url);
    if (!videoURL) {
      setError('Paste a YouTube video or Shorts HTTPS link.');
      return;
    }
    const input = JSON.stringify([url.trim(), title.trim()]);
    if (mutation.current?.input !== input)
      mutation.current = { input, nonce: crypto.randomUUID() };
    const signal = lifetime();
    await run(async () => {
      if (!joined) {
        if (!(await viewing.current?.set(true))) return;
        setJoined(true);
      }
      const queueBeforeEnqueue = await api<WatchQueueSnapshot>(
        `/rooms/${room.id}/watch-together/queue`,
        undefined,
        undefined,
        signal,
      );
      if (signal.aborted) return;
      await api(
        `/rooms/${room.id}/watch-together/queue`,
        {
          video_url: videoURL,
          title: title.trim(),
          client_nonce: mutation.current!.nonce,
          revision: queueBeforeEnqueue.revision,
        },
        'POST',
        signal,
      );
      if (start && !state && !signal.aborted) {
        const currentQueue = await api<WatchQueueSnapshot>(
          `/rooms/${room.id}/watch-together/queue`,
          undefined,
          undefined,
          signal,
        );
        if (!signal.aborted) {
          const started = await act(
            '/watch-together/next',
            {
              playback_id: '',
              revision: 0,
              queue_revision: currentQueue.revision,
            },
            'POST',
          );
          if (!started)
            throw new Error(
              'Your video is already in the queue, but playback could not start. Refresh the session and use Start queue when available.',
            );
        }
      }
      if (!signal.aborted) {
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
    return (
      <section
        aria-label="YouTube watch queue"
        className="space-y-3 rounded-2xl bc-card p-4"
      >
        <h3 className="font-heading text-base font-semibold">Watch YouTube together</h3>
        <p role="status" className="text-sm text-muted-foreground">
          {configured === null
            ? 'Checking YouTube availability…'
            : configurationFailed
              ? 'Could not check YouTube availability. Try again.'
              : 'YouTube watching is not enabled here yet. Shared video files are still available below.'}
        </p>
        <label className="block text-sm font-medium">
          Add a YouTube video or Short
          <input
            type="url"
            value={url}
            readOnly
            className="mt-2 min-h-11 w-full rounded-xl border bg-background px-3"
            placeholder="Paste a YouTube link"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Sending a link in chat does not start playback. Use Watch together
          once YouTube is available.
        </p>
        {configured !== null && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            onClick={() => void loadConfiguration()}
          >
            Check again
          </Button>
        )}
      </section>
    );
  return (
    <section
      aria-label="YouTube watch queue"
      className="space-y-4 [&_button]:min-h-11 [&_button]:min-w-11"
    >
      {browserRequired && <YouTubeBrowserRequired />}
      {canView ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bc-card p-3">
            <span className="inline-flex items-center gap-2 text-sm">
              <Users size={16} className="size-8 rounded-lg bg-pink/15 p-1.5 text-pink" />
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
          {canPost && !browserRequired && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void enqueue(!state);
              }}
              className="space-y-2 rounded-2xl bc-card p-4"
            >
              <label className="block text-sm font-medium">
                Add a YouTube video or Short
                <input
                  type="url"
                  className="mt-2 min-h-11 w-full rounded-xl border bg-background px-3"
                  placeholder="Paste a YouTube link"
                  value={url}
                  onChange={(event) => setURL(event.target.value)}
                  maxLength={2048}
                  disabled={blocked}
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                Title (optional)
                <input
                  className="mt-1 min-h-11 w-full rounded-xl border bg-background px-3 text-sm"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={200}
                  disabled={blocked}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {!state && (
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      blocked || !url.trim() || queue.items.length >= 100
                    }
                  >
                    <ListVideo size={14} /> Watch together
                  </Button>
                )}
                <Button
                  type={state ? 'submit' : 'button'}
                  variant={state ? 'default' : 'outline'}
                  size="sm"
                  disabled={blocked || !url.trim() || queue.items.length >= 100}
                  onClick={state ? undefined : () => void enqueue()}
                >
                  <Plus size={14} /> Add to queue
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {joined
                  ? 'The host controls playback. Each viewer allows YouTube before the player loads.'
                  : 'You will join Watch without turning on your microphone. Each viewer allows YouTube before the player loads.'}
              </p>
            </form>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="inline-flex items-center gap-2 font-heading text-base font-semibold">
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
                className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-background/60 p-2"
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-muted text-xs font-medium tabular-nums text-muted-foreground">
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
                  className="mt-1 min-h-11 w-full rounded-xl border bg-background px-2 text-sm"
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
        <h3 className="font-heading text-base font-semibold">Your private YouTube lists</h3>
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="Name for saved YouTube list"
            value={listName}
            onChange={(event) => setListName(event.target.value)}
            maxLength={100}
            placeholder="Movie night"
            className="min-h-11 min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm"
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
          <details key={list.id} className="rounded-2xl bc-card p-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
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
                className="mt-1 min-h-11 w-full rounded-xl border bg-background px-3 text-sm"
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
