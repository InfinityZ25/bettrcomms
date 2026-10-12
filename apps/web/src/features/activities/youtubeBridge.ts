export type YouTubePlayerEvent =
  | { type: 'ready' | 'ended' | 'buffering' | 'autoplay-blocked' }
  | { type: 'position'; position: number; duration: number; state: number }
  | {
      type: 'user-state';
      paused: boolean;
      position: number;
      revision: number;
      intent?: 'seek';
    }
  | { type: 'error'; code: number }
  | { type: 'bootstrap-error'; message: string };
export interface YouTubePlayback {
  position: number;
  paused: boolean;
  enabled: boolean;
  volume: number;
  muted: boolean;
  force: boolean;
  revision: number;
}
/** A host's SDK controls must be able to settle before their callbacks arrive. */
export function shouldApplyYouTubePlayback(
  next: YouTubePlayback,
  previous: YouTubePlayback | undefined,
  host: boolean,
): boolean {
  return (
    !host ||
    !previous ||
    next.force ||
    next.revision !== previous.revision ||
    next.enabled !== previous.enabled ||
    next.volume !== previous.volume ||
    next.muted !== previous.muted
  );
}
/** Official controls mutate shared state only after a meaningful change. */
export function youtubeHostAction(
  event: Extract<YouTubePlayerEvent, { type: 'user-state' }>,
  current: { paused: boolean; position: number; revision: number },
): 'play' | 'pause' | 'seek' | undefined {
  if (event.revision !== current.revision) return;
  if (event.paused !== current.paused) return event.paused ? 'pause' : 'play';
  if (Math.abs(event.position - current.position) > 1.5) return 'seek';
}
/** Seeking changes position without granting or revoking local playback consent. */
export function youtubeLocalPlaybackChange(
  event: Extract<YouTubePlayerEvent, { type: 'user-state' }>,
  host: boolean,
): boolean | undefined {
  if (event.intent === 'seek' || (host && event.paused)) return;
  return !event.paused;
}
const finite = (value: unknown, max: number) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max;
export function validPlayerEvent(
  value: unknown,
  nonce: string,
): value is YouTubePlayerEvent & { nonce: string } {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (event.nonce !== nonce || typeof event.type !== 'string') return false;
  const keys = Object.keys(event);
  const hasOnly = (...allowed: string[]) =>
    keys.every((key) => ['type', 'nonce', ...allowed].includes(key));
  switch (event.type) {
    case 'ready':
    case 'ended':
    case 'buffering':
    case 'autoplay-blocked':
      return hasOnly();
    case 'position':
      return (
        hasOnly('position', 'duration', 'state') &&
        finite(event.position, 604800) &&
        finite(event.duration, 604800) &&
        typeof event.state === 'number' &&
        [-1, 0, 1, 2, 3, 5].includes(event.state)
      );
    case 'user-state':
      return (
        hasOnly('position', 'paused', 'revision', 'intent') &&
        finite(event.position, 604800) &&
        typeof event.paused === 'boolean' &&
        (event.intent === undefined || event.intent === 'seek') &&
        typeof event.revision === 'number' &&
        Number.isSafeInteger(event.revision) &&
        event.revision >= 0
      );
    case 'error':
      return (
        hasOnly('code') &&
        typeof event.code === 'number' &&
        [2, 5, 100, 101, 150, 153].includes(event.code)
      );
    case 'bootstrap-error':
      return (
        hasOnly('message') &&
        typeof event.message === 'string' &&
        event.message.length <= 200
      );
    default:
      return false;
  }
}
/** The port is handed only to the exact isolated iframe window and origin. */
export function connectYouTubeBridge(
  frame: HTMLIFrameElement,
  origin: string,
  ticket: string,
  nonce: string,
  receive: (event: YouTubePlayerEvent) => void,
) {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    !['https:', 'http:'].includes(url.protocol) ||
    !frame.contentWindow ||
    ticket.length !== 43 ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(nonce)
  )
    throw new Error('Invalid isolated player connection');
  const channel = new MessageChannel();
  let closed = false;
  const timeout = setTimeout(() => {
    if (!closed)
      receive({
        type: 'bootstrap-error',
        message:
          'The isolated YouTube player did not answer. Reopen the player.',
      });
  }, 15000);
  channel.port1.onmessage = (event) => {
    if (!closed && validPlayerEvent(event.data, nonce)) {
      clearTimeout(timeout);
      receive(event.data);
    }
  };
  channel.port1.start();
  frame.contentWindow.postMessage(
    { type: 'bootstrap', ticket, nonce },
    origin,
    [channel.port2],
  );
  return {
    apply(value: YouTubePlayback) {
      if (!closed)
        channel.port1.postMessage({ type: 'playback', nonce, ...value });
    },
    close() {
      closed = true;
      clearTimeout(timeout);
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    },
  };
}
export function youtubeError(code: number) {
  switch (code) {
    case 100:
      return 'This video was removed or is private. Choose another video.';
    case 101:
    case 150:
      return 'The creator does not allow this video to play inside apps. Open it on YouTube or choose another.';
    case 153:
      return 'YouTube could not identify this player. Reopen it; if it continues, check the player domain configuration.';
    default:
      return 'YouTube could not play this video on your device. Retry or open it on YouTube.';
  }
}
