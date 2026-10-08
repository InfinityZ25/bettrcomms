export type ActivityEvent =
  | {
      type: 'channel.activity';
      room_id: string;
      kind: string;
    }
  | {
      type: 'soundboard.play';
      room_id: string;
      asset_id: string;
      event_id: string;
      duration_ms: number;
      played_at: string;
    };
const listeners = new Set<(event: ActivityEvent) => void>();
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

/** Called only by the application's authenticated realtime session. */
export function receiveActivityEvent(type: string, payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const value = payload as Record<string, unknown>;
  if (typeof value.room_id !== 'string' || !uuid.test(value.room_id)) return;
  let event: ActivityEvent;
  if (type === 'channel.activity' && typeof value.kind === 'string') {
    event = { type, room_id: value.room_id, kind: value.kind };
  } else if (
    type === 'soundboard.play' &&
    typeof value.asset_id === 'string' &&
    uuid.test(value.asset_id) &&
    typeof value.event_id === 'string' &&
    uuid.test(value.event_id) &&
    typeof value.duration_ms === 'number' &&
    value.duration_ms > 0 &&
    value.duration_ms <= 30000 &&
    typeof value.played_at === 'string' &&
    Number.isFinite(Date.parse(value.played_at))
  ) {
    event = {
      type,
      room_id: value.room_id,
      asset_id: value.asset_id,
      event_id: value.event_id,
      duration_ms: value.duration_ms,
      played_at: value.played_at,
    };
  } else return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* Isolate one consumer; the other subscriptions remain live. */
    }
  }
}

export function subscribeActivityEvents(
  listener: (event: ActivityEvent) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
