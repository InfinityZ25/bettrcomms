import { beforeEach, expect, it, vi } from 'vitest';

const sender = vi.hoisted(() => vi.fn());
const binding = vi.hoisted(() => vi.fn((_id, _token, command, args) => sender(command, args)));
vi.mock('@wailsio/runtime', () => ({ Call: { ByID: binding } }));
vi.mock('@/desktop/nativeMedia', () => ({ nativePageToken: () => 'test-only-page-token' }));
vi.mock('@/desktop/runtime', () => ({ readDesktopBootReport: () => ({ platform: 'android' }) }));
import { androidProjectionDriver, releaseOrphanedAndroidProjection } from './androidProjection';

beforeEach(() => { binding.mockClear(); sender.mockReset().mockResolvedValue(undefined); });

it('marks each share with this page load and releases broadcasts from other loads', async () => {
  await androidProjectionDriver.invoke('native_screen_start', { width: 720 });
  const start = sender.mock.calls[0];
  expect(start[0]).toBe('native_screen_start');
  expect(start[1]).toMatchObject({ width: 720, owner: expect.stringMatching(/^[0-9a-f]{32}$/) });

  releaseOrphanedAndroidProjection();
  // The same owner: the host keeps this page's broadcast and ends any other.
  expect(sender).toHaveBeenLastCalledWith('native_screen_release_orphans', { owner: start[1].owner });
});

it('passes other commands through untouched', async () => {
  await androidProjectionDriver.invoke('native_screen_stop', { sessionId: 'share' });
  expect(sender).toHaveBeenCalledWith('native_screen_stop', { sessionId: 'share' });
});

it('ends a share on return when the host no longer has it', async () => {
  const listener = vi.fn();
  const state = { visibility: 'hidden' };
  const events = new EventTarget();
  vi.stubGlobal('document', Object.defineProperty(events, 'visibilityState', { get: () => state.visibility }));
  vi.stubGlobal('window', new EventTarget());
  sender.mockImplementation(async (command: string) =>
    command === 'native_screen_start' ? { sessionId: 'share-1' } : command === 'native_screen_active' ? { sessionId: '' } : undefined);
  const unlisten = await androidProjectionDriver.listen(listener);
  await androidProjectionDriver.invoke('native_screen_start', {});
  // Stopped from the Android indicator while suspended: the ended event was lost.
  state.visibility = 'visible';
  events.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ payload: { sessionId: 'share-1', reason: 'Screen sharing ended.' } }));
  // Reported once; the next return finds nothing live to reconcile.
  events.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(listener).toHaveBeenCalledOnce();
  unlisten();
  vi.unstubAllGlobals();
});

it('keeps a share the host still has', async () => {
  const listener = vi.fn();
  const events = new EventTarget();
  vi.stubGlobal('document', Object.assign(events, { visibilityState: 'visible' }));
  vi.stubGlobal('window', new EventTarget());
  sender.mockImplementation(async (command: string) =>
    command === 'native_screen_start' || command === 'native_screen_active' ? { sessionId: 'share-2' } : undefined);
  const unlisten = await androidProjectionDriver.listen(listener);
  await androidProjectionDriver.invoke('native_screen_start', {});
  events.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(sender).toHaveBeenCalledWith('native_screen_active', {}));
  expect(listener).not.toHaveBeenCalled();
  unlisten();
  vi.unstubAllGlobals();
});

it('uses the token-gated Android binding for consent cancellation', async () => {
  await androidProjectionDriver.cancelPending();
  expect(binding).toHaveBeenCalledWith(0xBC170102, 'test-only-page-token', 'native_screen_cancel_pending', {});
});
