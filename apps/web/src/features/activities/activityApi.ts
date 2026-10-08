import { api, type MessageAttachment } from '@/api';
export { api };

export interface ChannelPoll {
  id: string;
  author_id: string | null;
  question: string;
  options: string[];
  counts: number[];
  vote: number | null;
  created_at: string;
  closes_at: string | null;
  closed_at: string | null;
}
export interface ScheduledChannelEvent {
  id: string;
  room_id: string;
  author_id: string | null;
  title: string;
  description: string;
  starts_at: string;
  cancelled_at: string | null;
  going: number;
  maybe: number;
  response: '' | 'going' | 'maybe' | 'declined';
}
export interface ChannelEventReminder {
  id: string;
  event_id: string;
  room_id: string;
  room_name: string;
  title: string;
  starts_at: string;
  created_at: string;
}
export interface WatchTogetherState {
  room_id: string;
  attachment: MessageAttachment;
  host_id: string | null;
  paused: boolean;
  position_seconds: number;
  revision: number;
  updated_at: string;
  server_time: string;
  can_claim: boolean;
}
export interface ChannelMediaAsset {
  id: string;
  name: string;
  kind: 'sticker' | 'sound';
  creator_id: string | null;
  attachment: MessageAttachment;
  duration_ms: number | null;
}
export interface ChannelActivitySnapshot {
  polls: ChannelPoll[];
  events: ScheduledChannelEvent[];
  assets: ChannelMediaAsset[];
  watch: WatchTogetherState | null;
}
export interface MessageEditVersion {
  version: number;
  body: string;
  changed_at: string;
}

/** Translate an authoritative server anchor into the viewer's monotonic clock. */
export function watchPosition(
  state: WatchTogetherState,
  receivedAt: number,
  now = performance.now(),
) {
  const serverElapsed = Math.max(
    0,
    (Date.parse(state.server_time) - Date.parse(state.updated_at)) / 1000,
  );
  const localElapsed = Math.max(0, (now - receivedAt) / 1000);
  return Math.min(
    604800,
    Math.max(
      0,
      state.position_seconds +
        (state.paused ? 0 : serverElapsed + localElapsed),
    ),
  );
}

export function pollClosed(poll: ChannelPoll, now = Date.now()) {
  return Boolean(
    poll.closed_at || (poll.closes_at && Date.parse(poll.closes_at) <= now),
  );
}
