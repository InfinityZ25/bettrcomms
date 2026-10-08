import { describe, expect, it } from 'vitest';
import {
  pollClosed,
  watchPosition,
  type ChannelPoll,
  type WatchTogetherState,
} from './activityApi';

const anchor: WatchTogetherState = {
  room_id: 'room',
  attachment: {
    id: 'video',
    filename: 'match.mp4',
    content_type: 'video/mp4',
    size_bytes: 100,
  },
  host_id: 'host',
  paused: false,
  position_seconds: 10,
  revision: 1,
  updated_at: '2026-10-01T10:00:00Z',
  server_time: '2026-10-01T10:00:03Z',
  can_claim: false,
};
describe('shared playback anchors', () => {
  it('uses server elapsed time and local monotonic elapsed time, avoiding viewer wall-clock skew', () => {
    expect(watchPosition(anchor, 1000, 3500)).toBe(15.5);
  });
  it('keeps paused position fixed and bounds clocks that moved backward', () => {
    expect(watchPosition({ ...anchor, paused: true }, 1000, 5000)).toBe(10);
    expect(
      watchPosition(
        { ...anchor, server_time: '2026-10-01T09:00:00Z' },
        3000,
        1000,
      ),
    ).toBe(10);
  });
  it('clamps runaway elapsed time to the server playback bound', () => {
    expect(watchPosition(anchor, 0, 1e10)).toBe(604800);
  });
});
describe('poll deadlines', () => {
  const poll = {
    closed_at: null,
    closes_at: '2026-10-01T12:00:00Z',
  } as ChannelPoll;
  it('closes at the exact deadline without waiting for another event', () => {
    expect(pollClosed(poll, Date.parse(poll.closes_at!) - 1)).toBe(false);
    expect(pollClosed(poll, Date.parse(poll.closes_at!))).toBe(true);
  });
  it('honors an early close and allows polls without deadlines', () => {
    expect(pollClosed({ ...poll, closed_at: '2026-10-01T10:00:00Z' })).toBe(
      true,
    );
    expect(pollClosed({ ...poll, closes_at: null })).toBe(false);
  });
});
