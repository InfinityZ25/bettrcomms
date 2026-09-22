import { getDesktopRuntime } from './runtime';

/**
 * Native notifications, where the host has them.
 *
 * Only the Wails host does: it registers Wails' notifications service, which
 * puts a real Windows toast in the Action Center. The browser build sends
 * nothing — the page is the notification there, and a web notification would
 * need a permission prompt to tell somebody about a window they are looking
 * at. The Tauri host has its own plugin and is not wired to this.
 */
export interface DesktopNotification {
  /** Stable per subject, so a second message replaces the first one's toast. */
  id: string;
  title: string;
  body: string;
  /** Handed back when the toast is clicked, for the page to act on. */
  data?: Record<string, unknown>;
}

/** What a clicked toast carries back, narrowed to what this app sends. */
export interface DesktopNotificationClick {
  id: string;
  data: Record<string, unknown>;
}

export function desktopNotificationsAvailable() {
  return getDesktopRuntime() === 'wails';
}

const service = () =>
  import(
    './wailsbindings/github.com/wailsapp/wails/v3/pkg/services/notifications/notificationservice.js'
  );

let authorised: Promise<boolean> | null = null;

/** Asked once. Windows always says yes; macOS is the platform that may not. */
function authorise() {
  authorised ??= service()
    .then((api) => api.RequestNotificationAuthorization())
    .catch(() => false);
  return authorised;
}

/**
 * Raises one toast. Resolves false when the host has none, so callers can fall
 * back to whatever they do in a browser.
 */
export async function notifyDesktop(
  notification: DesktopNotification,
): Promise<boolean> {
  if (!desktopNotificationsAvailable()) return false;
  try {
    if (!(await authorise())) return false;
    const api = await service();
    /*
      Only the fields this app means.

      A thread id used to go with these, which Wails maps to a Windows toast
      <header> — and a header's title is shown to the reader, so every
      notification was captioned with a room's UUID. Grouping is not worth
      that; the id alone already replaces one conversation's toast with its
      own successor.
    */
    await api.SendNotification({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      data: notification.data,
      // The app plays its own sound for the same event, and it is the one the
      // person chose in settings. Windows' own ding on top of it is one alert
      // too many.
      sound: { silent: true },
    });
    return true;
  } catch {
    // A toast that will not appear is not worth interrupting anything for.
    return false;
  }
}

/** Withdraws a toast whose subject the person has since dealt with. */
export async function clearDesktopNotification(id: string) {
  if (!desktopNotificationsAvailable()) return;
  try {
    await (await service()).RemoveNotification(id);
  } catch {
    // Nothing to withdraw.
  }
}

/**
 * Runs when somebody clicks one of this app's toasts.
 *
 * The host brings the window back and emits the response; this turns it into
 * the shape the page reasons about. Returns an unsubscribe.
 */
export function onDesktopNotificationClick(
  handler: (click: DesktopNotificationClick) => void,
): () => void {
  if (!desktopNotificationsAvailable()) return () => {};
  let cancelled = false;
  let off: (() => void) | undefined;
  void import('@wailsio/runtime')
    .then(({ Events }) => {
      if (cancelled) return;
      off = Events.On('desktop:notification-response', (event) => {
        const sent = event.data as unknown;
        const payload = (Array.isArray(sent) ? sent[0] : sent) as
          | { id?: string; data?: Record<string, unknown> }
          | undefined;
        if (!payload || typeof payload !== 'object') return;
        handler({ id: payload.id ?? '', data: payload.data ?? {} });
      });
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    off?.();
  };
}
