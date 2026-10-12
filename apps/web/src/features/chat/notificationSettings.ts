import { api, ApiRequestError } from '@/api';
import { desktopNotificationsAvailable, requestDesktopNotificationAuthorization } from '@/desktop/notifications';
import { subscribePersonalEvents, type QuietHours, type QuietSchedule } from '@/features/personal/api';

export type NotificationMode = 'all' | 'mentions' | 'mute';
type NotificationState = { rooms: Record<string, NotificationMode>; versions: Record<string, number>; mutedUntil: Record<string, string>; quiet: QuietHours | null; policyReceivedAt: number; dnd: boolean; localDnd: boolean; accountDnd: boolean; alerts: boolean; background: boolean; error: string; ready: boolean };
const listeners = new Set<() => void>();
let currentUser: string | undefined;
let state: NotificationState = { rooms: {}, versions: {}, mutedUntil: {}, quiet: null, policyReceivedAt: 0, dnd: false, localDnd: false, accountDnd: false, alerts: false, background: false, error: '', ready: false };
let accountDnd: { user: string; enabled: boolean } | undefined;
let sessionRevision = 0;
let pushOperation: Promise<void> = Promise.resolve();
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let policyEpoch = 0;
let policyTimer: ReturnType<typeof setTimeout> | undefined;
let policyRequest: AbortController | undefined;
let policyRetryDelay = 2000;
const deviceIds = new Map<string, string>();
const roomWrites = new Map<string, Promise<void>>();

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
export function notificationDeviceId(user = currentUser) {
  if (!user) return '';
  const known = deviceIds.get(user); if (known) return known;
  let id = '';
  try { id = localStorage.getItem(key(user, 'device-id')) ?? ''; } catch { /* Use an in-memory device identity when storage is unavailable. */ }
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) {
    id = crypto.randomUUID();
    try { localStorage.setItem(key(user, 'device-id'), id); } catch { /* Device registration still works for this session. */ }
  }
  deviceIds.set(user, id); return id;
}
export function notificationPolicyTime(snapshot = state) {
  const server = Date.parse(snapshot.quiet?.server_time ?? '');
  return Number.isFinite(server) ? server + Math.max(0, performance.now() - snapshot.policyReceivedAt) : Date.now();
}
export function roomIsMuted(room: string, snapshot = state, now = notificationPolicyTime(snapshot)) {
  return snapshot.rooms[room] === 'mute' || (Date.parse(snapshot.mutedUntil[room] ?? '') || 0) > now;
}
function effectiveDnd(local = state.localDnd, account = state.accountDnd, quiet = state.quiet) { return local || account || Boolean(quiet?.account_dnd || quiet?.active); }
function schedulePolicyRefresh() {
  if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined;
  if (policyTimer) clearTimeout(policyTimer);
  const now = notificationPolicyTime();
  const deadlines = [...Object.values(state.mutedUntil), ...(state.quiet?.next_change_at ? [state.quiet.next_change_at] : [])].map((value) => Date.parse(value)).filter((value) => Number.isFinite(value) && value > now);
  const wait = deadlines.length ? Math.min(60000, Math.max(100, Math.min(...deadlines) - now)) : 60000;
  policyTimer = setTimeout(() => { void refreshNotificationPolicy(); }, wait);
}
export async function refreshNotificationPolicy() {
  if (!currentUser) return;
  const revision = sessionRevision;
  const epoch = policyEpoch;
  policyRequest?.abort();
  const controller = new AbortController(); policyRequest = controller;
  let loaded = false;
  try {
    const [preferences, quiet] = await Promise.all([
      api<{ rooms: Record<string, NotificationMode>; muted_until?: Record<string, string>; versions?: Record<string, number> }>('/messages/notification-preferences', undefined, undefined, controller.signal),
      api<QuietHours>('/me/quiet-hours', undefined, undefined, controller.signal),
    ]);
    if (controller.signal.aborted || revision !== sessionRevision) return;
    if (epoch !== policyEpoch) { void refreshNotificationPolicy(); return; }
    update({ rooms: preferences.rooms, versions: preferences.versions ?? {}, mutedUntil: preferences.muted_until ?? {}, quiet, policyReceivedAt: performance.now(), dnd: effectiveDnd(state.localDnd, state.accountDnd, quiet), ready: true });
    loaded = true;
    policyRetryDelay = 2000;
  } catch {
    // Until the account policy is known, alert producers stay quiet.
    if (revision === sessionRevision && !controller.signal.aborted) update({ ready: false });
  } finally {
    if (policyRequest === controller) policyRequest = undefined;
    if (revision === sessionRevision && !controller.signal.aborted) {
      if (loaded) schedulePolicyRefresh();
      else { if (retryTimer) clearTimeout(retryTimer); retryTimer = setTimeout(() => { void refreshNotificationPolicy(); }, policyRetryDelay); policyRetryDelay = Math.min(60000, policyRetryDelay * 2); }
    }
  }
}
export async function saveQuietHours(schedule: QuietSchedule, expectedVersion: number) {
  if (!currentUser) throw new Error('Sign in to configure quiet hours.');
  const revision = sessionRevision;
  const quiet = await api<QuietHours>('/me/quiet-hours', { ...schedule, expected_version: expectedVersion }, 'PUT');
  if (revision !== sessionRevision) return;
  policyEpoch++;
  policyRetryDelay = 2000;
  update({ quiet, policyReceivedAt: performance.now(), dnd: effectiveDnd(state.localDnd, state.accountDnd, quiet) });
  schedulePolicyRefresh();
}
export async function setRoomTimedMute(room: string, until: Date | null) {
  return updateRoomPolicy(room, { muted_until: until?.toISOString() ?? null });
}
function updateRoomPolicy(room: string, patch: { mode?: NotificationMode; muted_until?: string | null }) {
  if (!currentUser) return Promise.resolve();
  const revision = sessionRevision;
  const task = (roomWrites.get(room) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (revision !== sessionRevision) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const expectedVersion = state.versions[room] ?? 0;
      try {
        await api('/messages/notification-preferences', { room_id: room, expected_version: expectedVersion, ...patch }, 'PUT');
        if (revision !== sessionRevision) return;
        policyEpoch++;
        const mutedUntil = { ...state.mutedUntil };
        if (patch.muted_until !== undefined) { if (patch.muted_until) mutedUntil[room] = patch.muted_until; else delete mutedUntil[room]; }
        update({ mutedUntil, rooms: patch.mode ? { ...state.rooms, [room]: patch.mode } : state.rooms, versions: { ...state.versions, [room]: expectedVersion + 1 } });
        schedulePolicyRefresh();
        return;
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.status !== 409 || attempt === 2) throw error;
        await refreshNotificationPolicy();
        if (revision !== sessionRevision) return;
      }
    }
  });
  roomWrites.set(room, task);
  void task.finally(() => { if (roomWrites.get(room) === task) roomWrites.delete(room); }).catch(() => {});
  return task;
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
        dnd: state.localDnd,
        device_id: notificationDeviceId(user),
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
  policyEpoch++;
  const savedDND = stored(user, 'dnd');
  const savedAlerts = storedAlerts(user);
  const ownDnd = accountDnd?.user === user && accountDnd.enabled;
  roomWrites.clear();
  update({ rooms: {}, versions: {}, mutedUntil: {}, quiet: null, policyReceivedAt: 0, dnd: savedDND || ownDnd, localDnd: savedDND, accountDnd: ownDnd, alerts: savedAlerts, background: false, error: '', ready: false });
  if (savedAlerts && pushSupported()) void syncPush();
  const off = subscribePersonalEvents((type) => { if (type === 'notification.policy.changed') void refreshNotificationPolicy(); });
  const focus = () => { void refreshNotificationPolicy(); };
  if (typeof window !== 'undefined') window.addEventListener?.('focus', focus);
  void refreshNotificationPolicy();
  return () => {
    off(); if (typeof window !== 'undefined') window.removeEventListener?.('focus', focus);
    if (sessionRevision !== revision) return;
    sessionRevision += 1;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    currentUser = undefined;
    policyRequest?.abort(); policyRequest = undefined; if (policyTimer) clearTimeout(policyTimer); policyTimer = undefined;
    roomWrites.clear();
    update({ rooms: {}, versions: {}, mutedUntil: {}, quiet: null, policyReceivedAt: 0, dnd: false, localDnd: false, accountDnd: false, alerts: false, background: false, error: '', ready: false });
  };
}
export async function setRoomNotificationMode(room: string, mode: NotificationMode) {
  return updateRoomPolicy(room, { mode });
}
export function setDoNotDisturb(enabled: boolean) {
  if (!currentUser) return;
  persist(currentUser, 'dnd', enabled);
  update({ localDnd: enabled, dnd: effectiveDnd(enabled) });
  if (state.alerts && pushSupported()) void syncPush();
}
/** Account status never overwrites this device's independent quiet preference. */
export function setAccountDoNotDisturb(user: string, enabled: boolean) {
  accountDnd = { user, enabled };
  if (currentUser === user) {
    const quiet = state.quiet ? { ...state.quiet, account_dnd: enabled } : null;
    update({ quiet, accountDnd: enabled, dnd: effectiveDnd(state.localDnd, enabled, quiet) });
  }
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
export async function notifyBrowser(title: string, body: string, onClick: () => void, roomId?: string, summary?: { tag: string; data: Record<string, unknown> }): Promise<boolean> {
  const user = currentUser;
  const revision = sessionRevision;
  if (!user || !state.ready || !state.alerts || state.dnd || !('Notification' in window) || Notification.permission !== 'granted') return false;
  const stillCurrent = () => user === currentUser && revision === sessionRevision && state.ready && state.alerts && !state.dnd && Notification.permission === 'granted';
  const tag = summary?.tag ?? (roomId ? `message:${roomId}` : undefined);
  if ((roomId || summary) && 'serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration('/push-sw.js');
      if (!stillCurrent()) return false;
      if (registration?.active) {
        await registration.showNotification(title, { body, tag, data: summary?.data ?? { roomId } });
        return true;
      }
    } catch { /* Fall back to a page notification when the worker is unavailable. */ }
  }
  if (!stillCurrent()) return false;
  const notification = new Notification(title, { body, tag, data: summary?.data ?? { roomId } });
  notification.onclick = () => { window.focus(); onClick(); notification.close(); };
  return true;
}
