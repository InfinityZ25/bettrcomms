import { api } from '@/api';

export type NotificationMode = 'all' | 'mentions' | 'mute';
type NotificationState = { rooms: Record<string, NotificationMode>; dnd: boolean; browser: boolean; ready: boolean };
const listeners = new Set<() => void>();
let currentUser: string | undefined;
let state: NotificationState = { rooms: {}, dnd: false, browser: false, ready: false };
let sessionRevision = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let roomOverrides: Record<string, NotificationMode> = {};

function key(user: string, setting: string) { return `bettercomms:notification:${user}:${setting}`; }
function stored(user: string, setting: string) {
  try { return localStorage.getItem(key(user, setting)) === 'true'; } catch { return false; }
}
function persist(user: string, setting: string, enabled: boolean) {
  try { localStorage.setItem(key(user, setting), String(enabled)); } catch { /* Browser storage may be disabled. */ }
}
function update(patch: Partial<NotificationState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
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
  update({ rooms: {}, dnd: stored(user, 'dnd'), browser: stored(user, 'browser'), ready: false });
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
    update({ rooms: {}, dnd: false, browser: false, ready: false });
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
}
export async function setBrowserNotifications(enabled: boolean): Promise<boolean> {
  const user = currentUser;
  const revision = sessionRevision;
  if (!user) return false;
  if (enabled) {
    if (!('Notification' in window)) return false;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;
  }
  if (sessionRevision !== revision || currentUser !== user) return false;
  persist(user, 'browser', enabled);
  update({ browser: enabled });
  return true;
}
export function notifyBrowser(title: string, body: string, onClick: () => void) {
  if (!state.browser || !('Notification' in window) || Notification.permission !== 'granted') return;
  const notification = new Notification(title, { body });
  notification.onclick = () => { window.focus(); onClick(); notification.close(); };
}
