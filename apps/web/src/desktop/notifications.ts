import { getDesktopRuntime } from './runtime';

/**
 * Native notifications, where the host has them.
 *
 * Only the Wails host does: it registers Wails' notifications service, which
 * puts a native notification in Windows or macOS. The browser build sends
 * nothing — the page is the notification there, and a web notification would
 * need a permission prompt to tell somebody about a window they are looking
 * at. The desktop host uses its Wails notification service.
 */
export interface DesktopNotification {
  /** Stable per subject; macOS can replace a prior notice with this ID. */
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

/** Windows always says yes; macOS may require explicit user approval. */
function authorise() {
  authorised ??= service()
    .then((api) => api.RequestNotificationAuthorization())
    .catch(() => false);
  return authorised.then((allowed) => {
    if (!allowed) authorised = null;
    return allowed;
  });
}

export function requestDesktopNotificationAuthorization(): Promise<boolean> {
  return desktopNotificationsAvailable() ? authorise() : Promise.resolve(false);
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
      notification was captioned with a room's UUID. We omit it here.
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
          | { id?: string; userInfo?: Record<string, unknown> }
          | undefined;
        if (!payload || typeof payload !== 'object') return;
        handler({ id: payload.id ?? '', data: payload.userInfo ?? {} });
      });
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    off?.();
  };
}
