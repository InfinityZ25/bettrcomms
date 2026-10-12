import { describe, expect, it, vi } from 'vitest';
import {
  connectYouTubeBridge,
  validPlayerEvent,
  youtubeError,
  youtubeHostAction,
  youtubeLocalPlaybackChange,
  shouldApplyYouTubePlayback,
  type YouTubePlayback,
} from './youtubeBridge';

describe('isolated YouTube bridge', () => {
  it('leaves same-revision host SDK controls alone while viewers keep syncing and explicit changes still apply', () => {
    const previous: YouTubePlayback = {
      position: 10,
      paused: true,
      enabled: true,
      volume: 0.7,
      muted: false,
      force: false,
      revision: 8,
    };
    expect(shouldApplyYouTubePlayback(previous, undefined, true)).toBe(true);
    for (const position of [10, 10.5, 11, 11.5]) {
      expect(
        shouldApplyYouTubePlayback({ ...previous, position }, previous, true),
      ).toBe(false);
      expect(
        shouldApplyYouTubePlayback({ ...previous, position }, previous, false),
      ).toBe(true);
    }
    for (const change of [
      { revision: 9 },
      { force: true },
      { volume: 0.3 },
      { muted: true },
      { enabled: false },
    ])
      expect(
        shouldApplyYouTubePlayback({ ...previous, ...change }, previous, true),
      ).toBe(true);
  });
  it('accepts only bounded player messages with the exact fresh nonce', () => {
    const nonce = 'fresh-instance-123456';
    expect(
      validPlayerEvent(
        { type: 'position', nonce, position: 3, duration: 60, state: 1 },
        nonce,
      ),
    ).toBe(true);
    for (const value of [
      { type: 'ready', nonce: 'previous-instance' },
      { type: 'ready', nonce, token: 'forbidden' },
      { type: 'position', nonce, position: Infinity, duration: 60, state: 1 },
      { type: 'user-state', nonce, position: -1, paused: false },
      { type: 'execute', nonce, method: 'native' },
      { type: 'error', nonce, code: 999 },
    ])
      expect(validPlayerEvent(value, nonce)).toBe(false);
  });
  it('hands the channel only to the exact helper iframe origin and closes it', () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    const channel = {
      port1: {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        start: vi.fn(),
        postMessage: vi.fn(),
        close,
      },
      port2: { close },
    };
    const saved = globalThis.MessageChannel;
    globalThis.MessageChannel = class {
      constructor() {
        return channel;
      }
    } as unknown as typeof MessageChannel;
    try {
      const receive = vi.fn();
      const bridge = connectYouTubeBridge(
        { contentWindow: { postMessage } } as unknown as HTMLIFrameElement,
        'https://player.bettrcomms.com',
        'x'.repeat(43),
        'fresh-instance-123456',
        receive,
      );
      expect(postMessage.mock.calls[0][1]).toBe(
        'https://player.bettrcomms.com',
      );
      expect(postMessage.mock.calls[0][2]).toEqual([channel.port2]);
      channel.port1.onmessage?.({ data: { type: 'ready', nonce: 'old' } });
      expect(receive).not.toHaveBeenCalled();
      channel.port1.onmessage?.({
        data: { type: 'ready', nonce: 'fresh-instance-123456' },
      });
      expect(receive).toHaveBeenCalledOnce();
      bridge.close();
      expect(close).toHaveBeenCalledTimes(2);
      expect(channel.port1.onmessage).toBeNull();
    } finally {
      globalThis.MessageChannel = saved;
    }
  });
  it('gives actionable per-device errors instead of automatically skipping', () => {
    expect(youtubeError(100)).toContain('private');
    expect(youtubeError(150)).toContain('creator');
    expect(youtubeError(153)).toContain('domain');
  });

  it('requires a bounded integer applied revision on official player control callbacks', () => {
    const nonce = 'fresh-instance-123456';
    const event = {
      type: 'user-state',
      nonce,
      paused: false,
      position: 2,
      revision: 5,
    };
    expect(validPlayerEvent(event, nonce)).toBe(true);
    for (const revision of [
      undefined,
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(validPlayerEvent({ ...event, revision }, nonce)).toBe(false);
  });

  it('ignores delayed echoes and stale revisions while preserving official play, pause and seek', () => {
    const current = { paused: false, position: 10, revision: 5 };
    const event = {
      type: 'user-state' as const,
      paused: false,
      position: 10.2,
      revision: 5,
    };
    expect(youtubeHostAction(event, current)).toBeUndefined();
    expect(
      youtubeHostAction({ ...event, position: 11.5 }, current),
    ).toBeUndefined();
    expect(
      youtubeHostAction({ ...event, paused: true, revision: 4 }, current),
    ).toBeUndefined();
    expect(
      youtubeHostAction({ ...event, paused: true, revision: 6 }, current),
    ).toBeUndefined();
    expect(youtubeHostAction({ ...event, paused: true }, current)).toBe(
      'pause',
    );
    expect(youtubeHostAction(event, { ...current, paused: true })).toBe('play');
    expect(youtubeHostAction({ ...event, position: 30 }, current)).toBe('seek');
    expect(
      youtubeHostAction(
        { ...event, paused: true, position: 30 },
        { ...current, paused: true },
      ),
    ).toBe('seek');
  });

  it('preserves local pause on seek without changing official play/pause or host seek decisions', () => {
    const seek = {
      type: 'user-state' as const,
      paused: false,
      position: 30,
      revision: 5,
      intent: 'seek' as const,
    };
    expect(youtubeLocalPlaybackChange(seek, false)).toBeUndefined();
    expect(youtubeLocalPlaybackChange(seek, true)).toBeUndefined();
    expect(
      youtubeHostAction(seek, { paused: false, position: 10, revision: 5 }),
    ).toBe('seek');
    const play = { ...seek, intent: undefined };
    expect(youtubeLocalPlaybackChange(play, false)).toBe(true);
    expect(youtubeLocalPlaybackChange(play, true)).toBe(true);
    expect(youtubeLocalPlaybackChange({ ...play, paused: true }, false)).toBe(
      false,
    );
    expect(
      youtubeLocalPlaybackChange({ ...play, paused: true }, true),
    ).toBeUndefined();
    const nonce = 'fresh-instance-123456';
    expect(validPlayerEvent({ ...seek, nonce }, nonce)).toBe(true);
    expect(validPlayerEvent({ ...seek, nonce, intent: 'play' }, nonce)).toBe(
      false,
    );
  });
});
