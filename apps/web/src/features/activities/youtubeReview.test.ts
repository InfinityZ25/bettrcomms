import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { connectYouTubeBridge } from './youtubeBridge';

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

function helper(fetch: ReturnType<typeof vi.fn>) {
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
  const startTimer = vi.fn(() => 1);
  const destroy = vi.fn();
  const playerCreated = vi.fn();
  let playerEvents: { onReady: () => void } | undefined;
  runInNewContext(helperScript!, {
    allowedParents: ['https://app.example.test', 'null'],
    window,
    location: { origin: 'https://player.example.test' },
    document: { createElement: () => ({}), head: { append } },
    fetch,
    AbortController,
    performance: { now: () => 2000 },
    setInterval: startTimer,
    clearInterval: vi.fn(),
    YT: {
      Player: class {
        constructor(_target: string, options: { events: typeof playerEvents }) {
          playerCreated();
          playerEvents = options.events;
        }
        destroy = destroy;
      },
    },
  });
  const port = {
    onmessage: undefined,
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
