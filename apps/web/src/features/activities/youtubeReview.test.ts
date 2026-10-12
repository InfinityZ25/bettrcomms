import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  connectYouTubeBridge,
  shouldApplyYouTubePlayback,
  validPlayerEvent,
  youtubeHostAction,
  youtubeLocalPlaybackChange,
  type YouTubePlayback,
} from './youtubeBridge';

// Exercise the exact script delivered by the credential-free player host.
const helperSource = readFileSync(
  new URL(
    '../../../../../server/internal/api/youtube_player.go',
    import.meta.url,
  ),
  'utf8',
);
const helperScript = helperSource.match(
  /const playerJavaScript = `([\s\S]*?)`\s*$/,
)?.[1];
if (!helperScript) throw new Error('Player helper script was not found');

function helper(
  fetch: ReturnType<typeof vi.fn>,
  initialState = 2,
  seekSettlesImmediately = true,
) {
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const parent = {};
  const window: Record<string, unknown> = {
    parent,
    addEventListener: (
      name: string,
      callback: (...args: unknown[]) => unknown,
    ) => events.set(name, callback),
    removeEventListener: (
      name: string,
      callback: (...args: unknown[]) => unknown,
    ) => {
      if (events.get(name) === callback) events.delete(name);
    },
  };
  const append = vi.fn();
  const startTimer = vi.fn((_callback: () => void) => 1);
  const destroy = vi.fn();
  const playerCreated = vi.fn();
  let currentState = initialState;
  let position = 0;
  let now = 2000;
  let playerInstance: object | undefined;
  const playVideo = vi.fn();
  const pauseVideo = vi.fn();
  const setVolume = vi.fn();
  const mute = vi.fn();
  const unMute = vi.fn();
  const seekTo = vi.fn((seconds: number) => {
    if (seekSettlesImmediately) position = seconds;
  });
  let playerEvents:
    | {
        onReady: () => void;
        onStateChange: (event: { data: number; target?: object }) => void;
      }
    | undefined;
  runInNewContext(helperScript!, {
    allowedParents: ['https://app.example.test', 'null'],
    window,
    location: { origin: 'https://player.example.test' },
    document: { createElement: () => ({}), head: { append } },
    fetch,
    AbortController,
    performance: { now: () => now },
    setInterval: startTimer,
    clearInterval: vi.fn(),
    YT: {
      Player: class {
        constructor(_target: string, options: { events: typeof playerEvents }) {
          playerCreated();
          playerEvents = options.events;
          playerInstance = this;
        }
        destroy = destroy;
        getPlayerState = () => currentState;
        getCurrentTime = () => position;
        getDuration = () => 60;
        playVideo = playVideo;
        pauseVideo = pauseVideo;
        setVolume = setVolume;
        mute = mute;
        unMute = unMute;
        seekTo = seekTo;
      },
    },
  });
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    start: vi.fn(),
    close: vi.fn(),
    postMessage: vi.fn(),
  };
  const event = {
    source: parent,
    origin: 'https://app.example.test',
    ports: [port],
    data: {
      type: 'bootstrap',
      ticket: 'x'.repeat(43),
      nonce: 'review-instance-123456',
    },
  };
  return {
    bootstrap: (value = event) =>
      events.get('message')?.(value) as Promise<void> | undefined,
    pagehide: () => events.get('pagehide')?.(),
    apiReady: () =>
      (window.onYouTubeIframeAPIReady as (() => void) | undefined)?.(),
    apiCallback: () =>
      window.onYouTubeIframeAPIReady as (() => void) | undefined,
    playerReady: () => playerEvents?.onReady(),
    command: (value: Partial<YouTubePlayback> = {}) =>
      port.onmessage?.({
        data: {
          type: 'playback',
          nonce: event.data.nonce,
          position: 0,
          paused: false,
          enabled: true,
          volume: 0.7,
          muted: false,
          force: false,
          revision: 1,
          ...value,
        },
      }),
    stateChange: (state: number, seconds = position) => {
      currentState = state;
      position = seconds;
      playerEvents?.onStateChange({ data: state, target: playerInstance });
    },
    staleStateChange: (state: number) =>
      playerEvents?.onStateChange({ data: state, target: playerInstance }),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    settlePosition: (seconds: number) => {
      position = seconds;
    },
    cacheState: (state: number) => {
      currentState = state;
    },
    tick: () => startTimer.mock.calls.at(-1)?.[0](),
    playVideo,
    pauseVideo,
    setVolume,
    mute,
    unMute,
    seekTo,
    event,
    append,
    startTimer,
    playerCreated,
    port,
  };
}
const claim = () => ({
  ok: true,
  json: async () => ({
    video_id: 'abcdefghijk',
    nonce: 'review-instance-123456',
    parent_origin: 'https://app.example.test',
  }),
});

describe('authoritative YouTube controls in the exact helper', () => {
  async function readyPlayer(initialState = 2, seekSettlesImmediately = true) {
    const player = helper(
      vi.fn().mockResolvedValue(claim()),
      initialState,
      seekSettlesImmediately,
    );
    await player.bootstrap();
    player.apiReady();
    player.playerReady();
    return player;
  }
  function userStates(player: Awaited<ReturnType<typeof readyPlayer>>) {
    return player.port.postMessage.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'user-state');
  }

  it('does not reassert a host pause while an official Play gesture updates SDK cache before its callback arrives', async () => {
    const player = await readyPlayer();
    let previous: YouTubePlayback | undefined;
    function synchronize(next: YouTubePlayback) {
      if (!shouldApplyYouTubePlayback(next, previous, true)) return;
      player.command(next);
      previous = next;
    }
    const paused: YouTubePlayback = {
      position: 10,
      paused: true,
      enabled: true,
      volume: 0.7,
      muted: false,
      force: true,
      revision: 8,
    };
    synchronize(paused);
    player.stateChange(2, 10);
    player.port.postMessage.mockClear();
    player.pauseVideo.mockClear();
    // The provider's internal state changes before it delivers the callback.
    player.cacheState(3);
    synchronize({ ...paused, force: false });
    player.cacheState(1);
    synchronize({ ...paused, force: false });
    expect(player.pauseVideo).not.toHaveBeenCalled();
    player.stateChange(1, 10);
    expect(userStates(player)).toEqual([
      {
        type: 'user-state',
        nonce: player.event.data.nonce,
        paused: false,
        position: 10,
        revision: 8,
      },
    ]);
    player.port.postMessage.mockClear();
    synchronize({ ...paused, paused: false, force: true, revision: 9 });
    player.cacheState(2);
    synchronize({
      ...paused,
      paused: false,
      force: false,
      revision: 9,
      position: 10.2,
    });
    expect(player.playVideo).not.toHaveBeenCalled();
    player.stateChange(2, 10.2);
    expect(userStates(player)).toEqual([
      {
        type: 'user-state',
        nonce: player.event.data.nonce,
        paused: true,
        position: 10.2,
        revision: 9,
      },
    ]);
  });

  it.each([-1, 5])(
    'does not seek or implicitly start an already-positioned initial SDK state %s',
    async (initialState) => {
      const player = await readyPlayer(initialState);
      player.command({ revision: 1, paused: true, force: true, position: 0 });
      expect(player.seekTo).not.toHaveBeenCalled();
      expect(player.playVideo).not.toHaveBeenCalled();
      expect(player.pauseVideo).not.toHaveBeenCalled();
      expect(userStates(player)).toEqual([]);
      player.command({ revision: 2, paused: false, force: true });
      expect(player.playVideo).toHaveBeenCalledOnce();
      player.stateChange(3);
      player.stateChange(1);
      expect(userStates(player)).toEqual([]);
      player.stateChange(2);
      expect(userStates(player)).toHaveLength(1);
    },
  );

  it('keeps an actual paused seek from CUED programmatic until the requested pause is acknowledged', async () => {
    const player = await readyPlayer(5);
    player.command({ revision: 1, paused: true, force: true, position: 10 });
    expect(player.seekTo).toHaveBeenCalledWith(10, true);
    expect(player.pauseVideo).toHaveBeenCalledOnce();
    player.stateChange(3, 10);
    player.stateChange(1, 10);
    expect(userStates(player)).toEqual([]);
    player.command({ revision: 1, paused: true, position: 10 });
    player.stateChange(2, 10);
    expect(userStates(player)).toEqual([]);
    player.stateChange(1, 10);
    expect(userStates(player)).toEqual([
      {
        type: 'user-state',
        nonce: player.event.data.nonce,
        paused: false,
        position: 10,
        revision: 1,
      },
    ]);
  });

  it.each([false, true])(
    'restores official controls when paused seek position settles without another state event (early PAUSED event: %s)',
    async (earlyPaused) => {
      const player = await readyPlayer(2, false);
      player.command({ revision: 12, paused: true, force: true, position: 10 });
      if (earlyPaused) player.stateChange(2, 0);
      expect(userStates(player)).toEqual([]);
      player.settlePosition(10);
      player.tick();
      expect(player.port.postMessage).toHaveBeenLastCalledWith({
        type: 'position',
        nonce: player.event.data.nonce,
        position: 10,
        duration: 60,
        state: 2,
      });
      player.stateChange(1, 10);
      expect(userStates(player)).toEqual([
        {
          type: 'user-state',
          nonce: player.event.data.nonce,
          paused: false,
          position: 10,
          revision: 12,
        },
      ]);
    },
  );

  it('does not acknowledge a playing seek from a cached timer sample before its transient pause and provider state acknowledgement', async () => {
    const player = await readyPlayer(1, false);
    player.command({ revision: 13, paused: false, force: true, position: 10 });
    player.settlePosition(10);
    player.tick();
    player.stateChange(2, 10);
    expect(userStates(player)).toEqual([]);
    player.stateChange(1, 10);
    expect(userStates(player)).toEqual([]);
    player.stateChange(2, 10);
    expect(userStates(player)).toEqual([
      {
        type: 'user-state',
        nonce: player.event.data.nonce,
        paused: true,
        position: 10,
        revision: 13,
      },
    ]);
  });

  it('does not clear a playing seek expectation from cached PLAYING or report its transient PAUSED callback as a user pause', async () => {
    const player = await readyPlayer(1);
    player.command({ revision: 3, paused: false, force: true, position: 10 });
    expect(player.playVideo).toHaveBeenCalledOnce();
    player.command({ revision: 3, paused: false, position: 10 });
    player.stateChange(2, 10);
    expect(userStates(player)).toEqual([]);
    player.stateChange(3, 10);
    player.stateChange(1, 10);
    expect(userStates(player)).toEqual([]);
    player.stateChange(2, 10);
    expect(userStates(player)).toEqual([
      {
        type: 'user-state',
        nonce: player.event.data.nonce,
        paused: true,
        position: 10,
        revision: 3,
      },
    ]);
  });

  it('does not mistake a delayed programmatic PLAYING acknowledgement for an official control gesture', async () => {
    const player = await readyPlayer();
    player.command({ revision: 7 });
    expect(player.playVideo).toHaveBeenCalledOnce();
    player.advance(5000);
    player.stateChange(1, 5);
    expect(userStates(player)).toEqual([]);
    player.stateChange(2, 5.2);
    expect(userStates(player)).toEqual([
      {
        type: 'user-state',
        nonce: player.event.data.nonce,
        paused: true,
        position: 5.2,
        revision: 7,
      },
    ]);
  });

  it('rejects older and malformed revisions while retaining same-revision local volume and playback consent', async () => {
    const player = await readyPlayer();
    player.command({ revision: 8, enabled: false });
    for (const revision of [
      7,
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      player.command({ revision, volume: 0.1, position: 40 });
    expect(player.setVolume).toHaveBeenCalledOnce();
    expect(player.seekTo).not.toHaveBeenCalled();
    expect(player.playVideo).not.toHaveBeenCalled();
    player.command({ revision: 8, volume: 0.4, enabled: true, muted: true });
    expect(player.setVolume).toHaveBeenLastCalledWith(40);
    expect(player.mute).toHaveBeenCalledOnce();
    expect(player.playVideo).toHaveBeenCalledOnce();
  });

  it('pauses buffering playback and ignores an obsolete PLAYING callback until the pause is acknowledged', async () => {
    const player = await readyPlayer();
    player.stateChange(3);
    player.command({ revision: 9, paused: true });
    expect(player.pauseVideo).toHaveBeenCalledOnce();
    player.advance(5000);
    player.stateChange(1);
    expect(userStates(player)).toEqual([]);
    player.stateChange(2);
    expect(userStates(player)).toEqual([]);
    player.staleStateChange(1);
    expect(userStates(player)).toEqual([]);
    player.stateChange(1);
    expect(userStates(player)).toEqual([
      {
        type: 'user-state',
        nonce: player.event.data.nonce,
        paused: false,
        position: 0,
        revision: 9,
      },
    ]);
  });

  it('reports an official seek while retaining the shared pause state and applied revision', async () => {
    const player = await readyPlayer();
    player.command({ revision: 11, paused: true, position: 10 });
    player.stateChange(2, 10);
    player.port.postMessage.mockClear();
    player.stateChange(3, 30);
    expect(userStates(player)).toEqual([
      {
        type: 'user-state',
        nonce: player.event.data.nonce,
        paused: true,
        position: 30,
        revision: 11,
        intent: 'seek',
      },
    ]);
  });

  it('keeps a locally paused viewer paused when seeking an otherwise playing shared video', async () => {
    const player = await readyPlayer();
    player.command({ revision: 11, paused: false, enabled: false });
    player.stateChange(3, 30);
    const [seek] = userStates(player);
    expect(validPlayerEvent(seek, player.event.data.nonce)).toBe(true);
    expect(youtubeLocalPlaybackChange(seek, false)).toBeUndefined();
    expect(
      youtubeHostAction(seek, { paused: false, position: 10, revision: 11 }),
    ).toBe('seek');
    player.stateChange(2, 30);
    expect(youtubeLocalPlaybackChange(userStates(player).at(-1), false)).toBe(
      false,
    );
    // A subsequent real Play still enables local playback.
    player.stateChange(1, 30);
    expect(youtubeLocalPlaybackChange(userStates(player).at(-1), false)).toBe(
      true,
    );
  });
});

describe('independent YouTube lifecycle review', () => {
  it('makes no external request before a bootstrap from the exact parent and passes no application credentials to claim', async () => {
    const fetch = vi.fn().mockResolvedValue(claim());
    const player = helper(fetch);
    expect(player.append).not.toHaveBeenCalled();
    await player.bootstrap({ ...player.event, source: {} });
    await player.bootstrap({
      ...player.event,
      origin: 'https://untrusted.example.test',
    });
    expect(fetch).not.toHaveBeenCalled();
    await player.bootstrap();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('/claim');
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket: 'x'.repeat(43),
        nonce: 'review-instance-123456',
        parent_origin: 'https://app.example.test',
      }),
    });
    expect(
      Object.keys(fetch.mock.calls[0][1]).every((name) =>
        ['method', 'credentials', 'headers', 'body', 'signal'].includes(name),
      ),
    ).toBe(true);
    expect(player.append).toHaveBeenCalledOnce();
  });

  it('does not append a third-party script when a claim resolves after pagehide cleanup', async () => {
    let finish!: (value: ReturnType<typeof claim>) => void;
    const player = helper(
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = player.bootstrap();
    player.pagehide();
    finish(claim());
    await pending;
    expect(player.port.close).toHaveBeenCalledOnce();
    expect(player.append).not.toHaveBeenCalled();
  });

  it('ignores a late YouTube API callback and player-ready event after pagehide cleanup', async () => {
    const player = helper(vi.fn().mockResolvedValue(claim()));
    await player.bootstrap();
    const queuedAPIReady = player.apiCallback();
    player.pagehide();
    queuedAPIReady?.();
    player.playerReady();
    expect(player.playerCreated).not.toHaveBeenCalled();
    expect(player.startTimer).not.toHaveBeenCalled();
  });

  it('does not recreate a timer when an existing player reports ready after cleanup', async () => {
    const player = helper(vi.fn().mockResolvedValue(claim()));
    await player.bootstrap();
    player.apiReady();
    player.pagehide();
    player.playerReady();
    expect(player.playerCreated).toHaveBeenCalledOnce();
    expect(player.startTimer).not.toHaveBeenCalled();
  });

  it('ignores an already queued message from a closed bridge instance', () => {
    const channel = {
      port1: {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        start: vi.fn(),
        close: vi.fn(),
        postMessage: vi.fn(),
      },
      port2: { close: vi.fn() },
    };
    vi.stubGlobal(
      'MessageChannel',
      class {
        constructor() {
          return channel;
        }
      },
    );
    try {
      const receive = vi.fn();
      const bridge = connectYouTubeBridge(
        {
          contentWindow: { postMessage: vi.fn() },
        } as unknown as HTMLIFrameElement,
        'https://player.example.test',
        'x'.repeat(43),
        'review-instance-123456',
        receive,
      );
      const queued = channel.port1.onmessage;
      bridge.close();
      queued?.({ data: { type: 'ready', nonce: 'review-instance-123456' } });
      expect(receive).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
