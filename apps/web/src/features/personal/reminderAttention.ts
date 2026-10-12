import { api, subscribePersonalEvents } from './api';
import { openPersonalInbox } from './inboxEvents';
import {
  desktopNotificationsAvailable,
  notifyDesktop,
} from '@/desktop/notifications';
import {
  notificationDeviceId,
  notificationSnapshot,
  notifyBrowser,
  subscribeNotifications,
} from '@/features/chat/notificationSettings';

/** Server leases coordinate page/native notices with Web Push for this device. */
export function startReminderAttention(userId: string) {
  const controller = new AbortController();
  const deviceId = notificationDeviceId(userId);
  let pending = false;
  async function reconcile() {
    if (pending || controller.signal.aborted) return;
    pending = true;
    try {
      const policy = notificationSnapshot();
      await api(
        '/me/reminder-attention/device',
        {
          device_id: deviceId,
          transport: desktopNotificationsAvailable() ? 'desktop' : 'page',
          dnd: policy.localDnd,
          alerts: policy.alerts,
        },
        'PUT',
        controller.signal,
      );
      if (
        !policy.ready ||
        !policy.alerts ||
        policy.dnd ||
        controller.signal.aborted
      )
        return;
      const claim = await api<{
        lease_id?: string;
        tag?: string;
        count: number;
      }>(
        '/me/reminder-attention/claim',
        { device_id: deviceId },
        'POST',
        controller.signal,
      );
      if (!claim.lease_id || !claim.count || controller.signal.aborted) return;
      const current = notificationSnapshot();
      if (!current.ready || !current.alerts || current.dnd) return;
      const tag = `bettercomms-reminders:${deviceId}`;
      const title =
        claim.count === 1
          ? 'One reminder is waiting'
          : `${claim.count} reminders are waiting`;
      const body = 'Open your personal inbox in BetterComms.';
      const data = { personalInbox: 'reminders' };
      const sent = desktopNotificationsAvailable()
        ? await notifyDesktop({ id: tag, title, body, data })
        : await notifyBrowser(
            title,
            body,
            () => openPersonalInbox('reminders'),
            undefined,
            { tag, data },
          );
      if (sent && !controller.signal.aborted)
        await api(
          '/me/reminder-attention/ack',
          { device_id: deviceId, lease_id: claim.lease_id },
          'POST',
          controller.signal,
        );
    } catch {
      /* Keep inbox rows and unacknowledged attention for retry. */
    } finally {
      pending = false;
    }
  }
  const refresh = () => {
    void reconcile();
  };
  const offPolicy = subscribeNotifications(refresh);
  const offEvents = subscribePersonalEvents((type) => {
    if (type === 'personal.reminders.changed') refresh();
  });
  window.addEventListener('focus', refresh);
  const timer = setInterval(refresh, 15000);
  refresh();
  return () => {
    controller.abort();
    offPolicy();
    offEvents();
    window.removeEventListener('focus', refresh);
    clearInterval(timer);
  };
}
