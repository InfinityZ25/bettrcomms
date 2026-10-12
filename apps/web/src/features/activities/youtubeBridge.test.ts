import { describe, expect, it, vi } from 'vitest';
import {
  connectYouTubeBridge,
  validPlayerEvent,
  youtubeError,
} from './youtubeBridge';

describe('isolated YouTube bridge', () => {
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
});
