import { beforeEach, expect, it, vi } from 'vitest';

const sender = vi.hoisted(() => vi.fn());
vi.mock('@/desktop/iosNativeBindings', () => ({ callIOSScreenSender: sender }));
vi.mock('@/desktop/runtime', () => ({ readDesktopBootReport: () => ({ platform: 'ios' }) }));
import { iosBroadcastDriver, releaseOrphanedIOSBroadcast } from './iosBroadcast';

beforeEach(() => sender.mockReset().mockResolvedValue(undefined));

it('marks each share with this page load and releases broadcasts from other loads', async () => {
  await iosBroadcastDriver.invoke('native_screen_start', { width: 720 });
  const start = sender.mock.calls[0];
  expect(start[0]).toBe('native_screen_start');
  expect(start[1]).toMatchObject({ width: 720, owner: expect.stringMatching(/^[0-9a-f]{32}$/) });

  releaseOrphanedIOSBroadcast();
  // The same owner: the host keeps this page's broadcast and ends any other.
  expect(sender).toHaveBeenLastCalledWith('native_screen_release_orphans', { owner: start[1].owner });
});

it('passes other commands through untouched', async () => {
  await iosBroadcastDriver.invoke('native_screen_stop', { sessionId: 'share' });
  expect(sender).toHaveBeenCalledWith('native_screen_stop', { sessionId: 'share' });
});
