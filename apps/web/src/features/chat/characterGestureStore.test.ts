import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  characterGestureConnectionSnapshot,
  characterGesturesSnapshot,
  clearCharacterGestures,
  receiveCharacterGesture,
  setCharacterGestureConnection,
  subscribeCharacterGestureConnection,
  subscribeCharacterGestures,
  type CharacterGestureEvent,
} from './characterGestureStore';

const gesture = (id: string, overrides: Partial<CharacterGestureEvent> = {}): CharacterGestureEvent => ({
  id, room_id: 'room', user_id: id, name: id, gesture: 'wave',
  character: { variant: 0, hue: null }, ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  setCharacterGestureConnection(true);
});
afterEach(() => {
  setCharacterGestureConnection(false);
  vi.useRealTimers();
});

describe('transient character gestures', () => {
  it('isolates rooms and threads and only expires the actual live gesture', () => {
    const onRoom = vi.fn();
    const unsubscribe = subscribeCharacterGestures('room', onRoom);
    receiveCharacterGesture(gesture('main'));
    const first = characterGesturesSnapshot('room');
    expect(characterGesturesSnapshot('room')).toBe(first);
    vi.advanceTimersByTime(2000);
    receiveCharacterGesture(gesture('thread', { thread_root_id: 'root' }));
    receiveCharacterGesture(gesture('other', { room_id: 'other' }));
    expect(characterGesturesSnapshot('room').map(({ id }) => id)).toEqual(['main']);
    expect(characterGesturesSnapshot('room', 'root').map(({ id }) => id)).toEqual(['thread']);
    vi.advanceTimersByTime(2000);
    expect(characterGesturesSnapshot('room')).toEqual([]);
    expect(characterGesturesSnapshot('room', 'root')).toHaveLength(1);
    expect(onRoom).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(characterGesturesSnapshot('room', 'root')).toEqual([]);
    expect(characterGesturesSnapshot('other')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it('deduplicates delivery without restarting animation or extending its lifetime', () => {
    const event = gesture('once');
    receiveCharacterGesture(event);
    const first = characterGesturesSnapshot('room');
    vi.advanceTimersByTime(3000);
    receiveCharacterGesture(event);
    expect(characterGesturesSnapshot('room')).toBe(first);
    vi.advanceTimersByTime(1000);
    receiveCharacterGesture(event);
    expect(characterGesturesSnapshot('room')).toEqual([]);
  });

  it('shows at most two senders and replaces an earlier gesture from the same sender', () => {
    receiveCharacterGesture(gesture('one', { user_id: 'alice' }));
    receiveCharacterGesture(gesture('two', { user_id: 'bob' }));
    receiveCharacterGesture(gesture('three', { user_id: 'alice', gesture: 'nod' }));
    expect(characterGesturesSnapshot('room').map(({ id }) => id)).toEqual(['two', 'three']);
    receiveCharacterGesture(gesture('four', { user_id: 'cora' }));
    expect(characterGesturesSnapshot('room').map(({ id }) => id)).toEqual(['three', 'four']);
  });

  it('clears only a revoked room including its threads', () => {
    receiveCharacterGesture(gesture('one'));
    receiveCharacterGesture(gesture('two', { thread_root_id: 'root' }));
    receiveCharacterGesture(gesture('three', { room_id: 'other' }));
    clearCharacterGestures('room');
    expect(characterGesturesSnapshot('room')).toEqual([]);
    expect(characterGesturesSnapshot('room', 'root')).toEqual([]);
    expect(characterGesturesSnapshot('other')).toHaveLength(1);
  });

  it('clears all activity and timers on disconnect and ignores late socket delivery', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCharacterGestureConnection(listener);
    receiveCharacterGesture(gesture('one'));
    setCharacterGestureConnection(false);
    expect(characterGestureConnectionSnapshot()).toBe(false);
    expect(characterGesturesSnapshot('room')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    receiveCharacterGesture(gesture('late'));
    expect(characterGesturesSnapshot('room')).toEqual([]);
    setCharacterGestureConnection(true);
    expect(characterGesturesSnapshot('room')).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('bounds unattended room activity and rejects unknown gesture kinds', () => {
    for (let index = 0; index < 65; index++) {
      receiveCharacterGesture(gesture(String(index), { room_id: `room-${index}` }));
    }
    expect(characterGesturesSnapshot('room-0')).toEqual([]);
    expect(characterGesturesSnapshot('room-64')).toHaveLength(1);
    receiveCharacterGesture(gesture('unknown', { gesture: 'unknown' as 'wave' }));
    expect(characterGesturesSnapshot('room')).toEqual([]);
    clearCharacterGestures();
    expect(vi.getTimerCount()).toBe(0);
  });
});
