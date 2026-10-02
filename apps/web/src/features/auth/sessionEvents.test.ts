import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionExpired, sessionGeneration, setSessionIdentity, subscribeSessionExpiry } from './sessionEvents';

afterEach(() => setSessionIdentity(null));

describe('account session invalidation', () => {
  it('ignores an expired response from a previous signed-in account', () => {
    setSessionIdentity('first');
    const previous = sessionGeneration();
    setSessionIdentity('second');
    const listener = vi.fn();
    const stop = subscribeSessionExpiry(listener);
    sessionExpired(previous);
    expect(listener).not.toHaveBeenCalled();
    sessionExpired();
    expect(listener).toHaveBeenCalledOnce();
    stop();
  });
  it('removes the session subscriber when its owner unmounts', () => {
    const listener = vi.fn();
    const stop = subscribeSessionExpiry(listener);
    stop();
    sessionExpired();
    expect(listener).not.toHaveBeenCalled();
  });
});
