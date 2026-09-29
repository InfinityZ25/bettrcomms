import { api } from '@/api';
import { desktopNotificationsAvailable, requestDesktopNotificationAuthorization } from '@/desktop/notifications';

export type NotificationMode = 'all' | 'mentions' | 'mute';
type NotificationState = { rooms: Record<string, NotificationMode>; dnd: boolean; alerts: boolean; background: boolean; error: string; ready: boolean };
const listeners = new Set<() => void>();
let currentUser: string | undefined;
let state: NotificationState = { rooms: {}, dnd: false, alerts: false, background: false, error: '', ready: false };
let sessionRevision = 0;
let pushOperation: Promise<void> = Promise.resolve();
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let roomOverrides: Record<string, NotificationMode> = {};

function key(user: string, setting: string) { return `bettercomms:notification:${user}:${setting}`; }
function stored(user: string, setting: string) {
  try { return localStorage.getItem(key(user, setting)) === 'true'; } catch { return false; }
}
function storedAlerts(user: string) {
  try {
    const saved = localStorage.getItem(key(user, 'alerts'));
    return saved === null ? stored(user, 'browser') : saved === 'true';
  } catch { return false; }
}
function persist(user: string, setting: string, enabled: boolean) {
  try { localStorage.setItem(key(user, setting), String(enabled)); } catch { /* Browser storage may be disabled. */ }
}
function update(patch: Partial<NotificationState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
function pushSupported() {
  return !desktopNotificationsAvailable() && typeof navigator !== 'undefined' && typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}
function publicKeyBytes(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
function queuePush(operation: () => Promise<void>) {
  const pending = pushOperation.then(operation, operation);
  pushOperation = pending.catch(() => {});
  return pending;
}
function syncPush() {
  const user = currentUser;
  const revision = sessionRevision;
  return queuePush(async () => {
    if (!user || user !== currentUser || revision !== sessionRevision || !state.alerts || !pushSupported() || Notification.permission !== 'granted') return;
    try {
      const { public_key } = await api<{ public_key: string }>('/push/subscription');
      await navigator.serviceWorker.register('/push-sw.js', { scope: '/' });
      const registration = await navigator.serviceWorker.ready;
      const key = publicKeyBytes(public_key);
      let subscription = await registration.pushManager.getSubscription();
      const savedKey = subscription?.options.applicationServerKey;
      const savedBytes = savedKey ? new Uint8Array(savedKey) : null;
      if (subscription && (!savedBytes || savedBytes.length !== key.length || !key.every((byte, index) => byte === savedBytes[index]))) {
        try { await api('/push/subscription', { endpoint: subscription.endpoint }, 'DELETE'); } catch { /* An expired old endpoint will be pruned by the server. */ }
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      if (revision !== sessionRevision || user !== currentUser || !state.alerts) return;
      const serialized = subscription.toJSON();
      if (!serialized.keys?.p256dh || !serialized.keys.auth) throw new Error('Incomplete push subscription');
      await api('/push/subscription', {
        endpoint: subscription.endpoint,
        keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth },
        dnd: state.dnd,
      }, 'POST');
      if (revision === sessionRevision && state.alerts) update({ background: true, error: '' });
    } catch {
      if (revision === sessionRevision && state.alerts) update({ background: false, error: 'Background alerts unavailable. Check Web Push server configuration and browser support.' });
    }
  });
}
async function stopPushNow() {
  if (!pushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/push-sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    try { await api('/push/subscription', { endpoint: subscription.endpoint }, 'DELETE'); } catch { /* The push service will reject an unsubscribed endpoint. */ }
    await subscription.unsubscribe();
    update({ background: false, error: '' });
  } catch { /* Logout remains available if the browser's push service fails. */ }
}
export function stopPushForThisBrowser() { return queuePush(stopPushNow); }
export const notificationSnapshot = () => state;
export function subscribeNotifications(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function startNotificationSession(user: string) {
  const revision = ++sessionRevision;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  currentUser = user;
  roomOverrides = {};
  const savedDND = stored(user, 'dnd');
  const savedAlerts = storedAlerts(user);
  update({ rooms: {}, dnd: savedDND, alerts: savedAlerts, background: false, error: '', ready: false });
  if (savedAlerts && pushSupported()) void syncPush();
  let retryDelay = 2000;
  const load = () => {
    void api<{ rooms: Record<string, NotificationMode> }>('/messages/notification-preferences')
      .then((result) => {
        if (sessionRevision === revision)
          update({ rooms: { ...result.rooms, ...roomOverrides }, ready: true });
      })
      .catch(() => {
        if (sessionRevision !== revision) return;
        retryTimer = setTimeout(load, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60_000);
      });
  };
  load();
  return () => {
    if (sessionRevision !== revision) return;
    sessionRevision += 1;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    currentUser = undefined;
    roomOverrides = {};
    update({ rooms: {}, dnd: false, alerts: false, background: false, error: '', ready: false });
  };
}
export async function setRoomNotificationMode(room: string, mode: NotificationMode) {
  const user = currentUser;
  const revision = sessionRevision;
  if (!user) return;
  await api('/messages/notification-preferences', { room_id: room, mode }, 'PUT');
  if (sessionRevision === revision) {
    roomOverrides = { ...roomOverrides, [room]: mode };
    update({ rooms: { ...state.rooms, [room]: mode } });
  }
}
export function setDoNotDisturb(enabled: boolean) {
  if (!currentUser) return;
  persist(currentUser, 'dnd', enabled);
  update({ dnd: enabled });
  if (state.alerts && pushSupported()) void syncPush();
}
export async function setSystemNotifications(enabled: boolean): Promise<boolean> {
  const user = currentUser;
  const revision = sessionRevision;
  if (!user) return false;
  if (enabled) {
    if (desktopNotificationsAvailable()) {
      if (!(await requestDesktopNotificationAuthorization())) {
        if (revision === sessionRevision) update({ error: 'Enable BetterComms notifications in your system settings.' });
        return false;
      }
    } else {
      if (!('Notification' in window)) return false;
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return false;
    }
  }
  if (sessionRevision !== revision || currentUser !== user) return false;
  persist(user, 'alerts', enabled);
  update({ alerts: enabled, background: false, error: '' });
  if (!desktopNotificationsAvailable()) {
    if (enabled) await syncPush();
    else await stopPushForThisBrowser();
  }
  return true;
}
export function notifyBrowser(title: string, body: string, onClick: () => void, tag?: string) {
  if (!state.alerts || !('Notification' in window) || Notification.permission !== 'granted') return;
  const notification = new Notification(title, { body, tag });
  notification.onclick = () => { window.focus(); onClick(); notification.close(); };
}
