import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/api';
import { keepWatchPresence } from './watchHeartbeat';

describe('independent Watch viewing and hosting leases', () => {
  it('retains viewing when a playback revision races or hosting permission changes', async () => {
    for (const status of [409, 403, 404]) {
      expect(
        await keepWatchPresence(
          vi.fn().mockResolvedValue({}),
          vi
            .fn()
            .mockRejectedValue(new ApiRequestError('Host changed', status)),
        ),
      ).toBe('changed');
    }
  });
  it('retains local viewing through a transient request failure', async () => {
    const hosting = vi.fn();
    expect(
      await keepWatchPresence(
        vi.fn().mockRejectedValue(new TypeError('Network unavailable')),
        hosting,
      ),
    ).toBe('interrupted');
    expect(hosting).not.toHaveBeenCalled();
    expect(
      await keepWatchPresence(
        vi.fn().mockResolvedValue({}),
        vi.fn().mockRejectedValue(new TypeError('Network unavailable')),
      ),
    ).toBe('interrupted');
  });
  it('withdraws local viewing immediately when membership or authentication was revoked', async () => {
    for (const status of [401, 403, 404]) {
      expect(
        await keepWatchPresence(
          vi
            .fn()
            .mockRejectedValue(new ApiRequestError('Access removed', status)),
        ),
      ).toBe('revoked');
    }
  });
  it('allows a viewer without requesting microphone access or a host lease', async () => {
    const viewing = vi.fn().mockResolvedValue({});
    expect(await keepWatchPresence(viewing)).toBe('present');
    expect(viewing).toHaveBeenCalledOnce();
  });
});
