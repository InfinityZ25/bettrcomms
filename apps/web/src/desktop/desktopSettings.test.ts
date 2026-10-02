import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginDesktopActivity } from './desktopSettings';

const mocks = vi.hoisted(() => ({ activity: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./runtime', () => ({ getDesktopRuntime: () => 'wails' }));
vi.mock('./nativeMedia', () => ({ nativePageToken: () => 'private-page-token' }));
vi.mock('./wailsbindings/bettercomms/desktop-wails/desktopupdateservice', () => ({ Activity: mocks.activity }));

beforeEach(() => { vi.useFakeTimers(); mocks.activity.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

it('shares one heartbeat and releases only after all page-owned media tasks finish', async () => {
  const stopCall = beginDesktopActivity();
  const stopRecording = beginDesktopActivity();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.activity).toHaveBeenCalledTimes(1);
  const id = mocks.activity.mock.calls[0][1];
  expect(mocks.activity.mock.calls[0][2]).toBe(true);
  stopCall();
  await vi.advanceTimersByTimeAsync(3000);
  expect(mocks.activity).toHaveBeenCalledTimes(2);
  expect(mocks.activity.mock.calls[1][1]).toBe(id);
  stopRecording();
  stopRecording();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.activity).toHaveBeenLastCalledWith('private-page-token', id, false);
  const count = mocks.activity.mock.calls.length;
  await vi.advanceTimersByTimeAsync(12000);
  expect(mocks.activity).toHaveBeenCalledTimes(count);
});
