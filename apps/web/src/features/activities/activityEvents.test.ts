import { describe, expect, it, vi } from 'vitest';
import {
  receiveActivityEvent,
  subscribeActivityEvents,
} from './activityEvents';

const room = '12345678-1234-4234-9234-123456789012';
const asset = '12345678-1234-4234-9234-123456789013';
const event = '12345678-1234-4234-9234-123456789014';
describe('activity realtime boundaries', () => {
  it('rejects malformed events and impossible sound durations', () => {
    const listener = vi.fn();
    const off = subscribeActivityEvents(listener);
    receiveActivityEvent('channel.activity', { room_id: 'bad', kind: 'polls' });
    receiveActivityEvent('soundboard.play', {
      room_id: room,
      asset_id: asset,
      event_id: event,
      duration_ms: 30001,
      played_at: '2026-10-01T12:00:00Z',
    });
    receiveActivityEvent('soundboard.play', {
      room_id: room,
      asset_id: asset,
      event_id: event,
      duration_ms: 1000,
      played_at: 'bad',
    });
    expect(listener).not.toHaveBeenCalled();
    off();
  });
  it('isolates a failing consumer and releases subscriptions', () => {
    const broken = subscribeActivityEvents(() => {
      throw new Error('consumer failure');
    });
    const listener = vi.fn();
    const off = subscribeActivityEvents(listener);
    receiveActivityEvent('soundboard.play', {
      room_id: room,
      asset_id: asset,
      event_id: event,
      duration_ms: 1000,
      played_at: '2026-10-01T12:00:00Z',
    });
    expect(listener).toHaveBeenCalledOnce();
    broken();
    off();
    receiveActivityEvent('channel.activity', { room_id: room, kind: 'polls' });
    expect(listener).toHaveBeenCalledOnce();
  });
});
