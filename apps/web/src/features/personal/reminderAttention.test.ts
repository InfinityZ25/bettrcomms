import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { notifyDesktop } from '@/desktop/notifications';
import { notifyBrowser } from '@/features/chat/notificationSettings';
import { receivePersonalEvent } from './api';
import { startReminderAttention } from './reminderAttention';

const settings = vi.hoisted(() => ({
  ready: true,
  alerts: true,
  dnd: false,
  localDnd: false,
  rooms: { room: 'mute' },
}));
const desktop = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/api', async (original) => ({
  ...(await original<typeof import('@/api')>()),
  api: vi.fn(),
}));
vi.mock('@/desktop/notifications', () => ({
  desktopNotificationsAvailable: () => desktop.enabled,
  notifyDesktop: vi.fn(),
}));
vi.mock('@/features/chat/notificationSettings', () => ({
  notificationDeviceId: () => '11111111-1111-4111-8111-111111111111',
  notificationSnapshot: () => settings,
  notifyBrowser: vi.fn(),
  subscribeNotifications: () => () => {},
}));
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  desktop.enabled = false;
  Object.assign(settings, {
    ready: true,
    alerts: true,
    dnd: false,
    localDnd: false,
  });
  vi.mocked(notifyBrowser).mockResolvedValue(true);
  vi.mocked(notifyDesktop).mockResolvedValue(true);
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('/claim') ? { lease_id: 'lease', count: 2 } : {},
  );
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function start() {
  stop = startReminderAttention('alice');
  await vi.advanceTimersByTimeAsync(0);
}
describe('leased personal reminder attention', () => {
  it('registers the same device identity used for push, ignores room mute and acknowledges one generic page notice', async () => {
    await start();
    expect(api).toHaveBeenCalledWith(
      '/me/reminder-attention/device',
      {
        device_id: '11111111-1111-4111-8111-111111111111',
        transport: 'page',
        dnd: false,
        alerts: true,
      },
      'PUT',
      expect.any(AbortSignal),
    );
    expect(notifyBrowser).toHaveBeenCalledOnce();
    expect(notifyBrowser).toHaveBeenCalledWith(
      '2 reminders are waiting',
      'Open your personal inbox in BetterComms.',
      expect.any(Function),
      undefined,
      {
        tag: 'bettercomms-reminders:11111111-1111-4111-8111-111111111111',
        data: { personalInbox: 'reminders' },
      },
    );
    expect(api).toHaveBeenCalledWith(
      '/me/reminder-attention/ack',
      { device_id: '11111111-1111-4111-8111-111111111111', lease_id: 'lease' },
      'POST',
      expect.any(AbortSignal),
    );
  });
  it('does not claim while account or device quiet is active and sends one summary after resuming', async () => {
    settings.dnd = true;
    settings.localDnd = true;
    await start();
    expect(api).not.toHaveBeenCalledWith(
      '/me/reminder-attention/claim',
      expect.anything(),
      'POST',
      expect.anything(),
    );
    settings.dnd = false;
    settings.localDnd = false;
    receivePersonalEvent('personal.reminders.changed');
    await vi.advanceTimersByTimeAsync(0);
    expect(notifyBrowser).toHaveBeenCalledOnce();
  });
  it('does not acknowledge a notification the operating system did not show', async () => {
    desktop.enabled = true;
    vi.mocked(notifyDesktop).mockResolvedValue(false);
    await start();
    expect(notifyDesktop).toHaveBeenCalledOnce();
    expect(notifyBrowser).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalledWith(
      '/me/reminder-attention/ack',
      expect.anything(),
      'POST',
      expect.anything(),
    );
  });
  it('ignores a claim that finishes after logout and removes the renewal timer', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementation((path) =>
      path.endsWith('/claim')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({}),
    );
    await start();
    stop?.();
    stop = undefined;
    finish({ lease_id: 'late', count: 3 });
    await vi.advanceTimersByTimeAsync(30000);
    expect(notifyDesktop).not.toHaveBeenCalled();
    expect(notifyBrowser).not.toHaveBeenCalled();
    expect(
      vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/device')),
    ).toHaveLength(1);
  });
});
