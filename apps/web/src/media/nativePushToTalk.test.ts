import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativePushToTalk } from './nativePushToTalk';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

describe('native push-to-talk registration', () => {
  let input: NativePushToTalk;
  const pressed = vi.fn(), status = vi.fn();
  const snapshot = (sequence = 0, down = false, healthy = true) => ({ sessionId: 'test-session', sequence, pressed: down, healthy, focused: false });
  const event = (value: ReturnType<typeof snapshot>) => mocks.listen.mock.calls[0][1]({ payload: value });
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    mocks.listen.mockResolvedValue(mocks.unlisten);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'push_to_talk_capabilities') return { available: true, detail: '' };
      if (command === 'push_to_talk_start' || command === 'push_to_talk_heartbeat') return snapshot();
    });
    input = new NativePushToTalk(pressed, status);
  });
  afterEach(() => { input.dispose(); vi.useRealTimers(); });
  const start = () => input.start({ kind: 'keyboard', code: 'KeyV' });

  it('registers once and ignores stale, duplicate, and foreign events', async () => {
    await start(); expect(pressed.mock.lastCall?.[0]).toBe(false);
    event(snapshot(1, true)); expect(pressed.mock.lastCall?.[0]).toBe(true);
    event(snapshot(0, false)); event({ ...snapshot(2), sessionId: 'old-session' });
    expect(pressed.mock.lastCall?.[0]).toBe(true);
    event(snapshot(2)); expect(pressed.mock.lastCall?.[0]).toBe(false);
    expect(status).toHaveBeenLastCalledWith('active', expect.any(String));
  });
  it('stops an expired session and never reopens on a late event', async () => {
    await start(); event(snapshot(1, true)); event(snapshot(2, false, false));
    expect(pressed.mock.lastCall?.[0]).toBe(false);
    expect(status).toHaveBeenLastCalledWith('unavailable', expect.any(String));
    event(snapshot(3, true)); expect(pressed.mock.lastCall?.[0]).toBe(false);
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith('push_to_talk_stop', { sessionId: 'test-session' });
  });
  it('fails closed when the heartbeat cannot complete', async () => {
    await start(); event(snapshot(1, true));
    mocks.invoke.mockImplementation(command => command === 'push_to_talk_heartbeat' ? new Promise(() => {}) : Promise.resolve());
    await vi.advanceTimersByTimeAsync(3100);
    expect(pressed.mock.lastCall?.[0]).toBe(false);
    expect(status).toHaveBeenLastCalledWith('unavailable', expect.any(String));
  });
  it('disposes registrations that finish after leaving or rebinding', async () => {
    let resolve!: (value: ReturnType<typeof snapshot>) => void;
    mocks.invoke.mockImplementation(command => command === 'push_to_talk_start'
      ? new Promise(done => { resolve = done; }) : Promise.resolve({ available: true }));
    const pending = start(); await vi.advanceTimersByTimeAsync(0);
    input.dispose(); resolve(snapshot()); await pending;
    expect(mocks.invoke).toHaveBeenCalledWith('push_to_talk_stop', { sessionId: 'test-session' });
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalledWith('active', expect.anything());
  });
  it('reports registration failure without silently enabling an open mic', async () => {
    mocks.invoke.mockRejectedValue('Unsupported global key');
    await start(); expect(pressed.mock.lastCall?.[0]).toBe(false);
    expect(status).toHaveBeenLastCalledWith('unavailable', 'Unsupported global key');
  });
  it('uses explicitly reported foreground mode on unsupported platforms', async () => {
    mocks.invoke.mockResolvedValue({ available: false, detail: 'Foreground only' });
    await start();
    expect(status).toHaveBeenLastCalledWith('foreground', 'Foreground only');
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith('push_to_talk_start', expect.anything());
  });
});
