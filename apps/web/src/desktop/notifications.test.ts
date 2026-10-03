import { describe, expect, it, vi } from 'vitest';
import { onDesktopNotificationClick } from './notifications';

const bridge = vi.hoisted(() => ({
  callback: null as null | ((event: { data: unknown }) => void),
  unsubscribe: vi.fn(),
}));

vi.mock('./runtime', () => ({ getDesktopRuntime: () => 'wails', readDesktopBootReport: () => ({ platform: 'windows' }) }));
vi.mock('@wailsio/runtime', () => ({
  Events: {
    On: (_name: string, callback: (event: { data: unknown }) => void) => {
      bridge.callback = callback;
      return bridge.unsubscribe;
    },
  },
}));

describe('native notification responses', () => {
  it('opens the room carried in Wails userInfo when a notification is clicked', async () => {
    const handler = vi.fn();
    const stop = onDesktopNotificationClick(handler);
    await vi.waitFor(() => expect(bridge.callback).not.toBeNull());
    bridge.callback?.({ data: [{ id: 'message:room', userInfo: { roomId: 'room' } }] });
    expect(handler).toHaveBeenCalledWith({ id: 'message:room', data: { roomId: 'room' } });
    stop();
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
  });
});
