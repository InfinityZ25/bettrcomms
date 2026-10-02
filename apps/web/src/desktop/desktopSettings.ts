import { getDesktopRuntime } from './runtime';
import { nativePageToken } from './nativeMedia';

const preferences = () => import('./wailsbindings/bettercomms/desktop-wails/desktoppreferencesservice');
const updates = () => import('./wailsbindings/bettercomms/desktop-wails/desktopupdateservice');
export interface StartupStatus { available: boolean; enabled: boolean; approvalRequired: boolean; detail: string }
export interface UpdateStatus {
  available: boolean; state: string; currentVersion: string; version: string; detail: string;
  notes: string; automatic: boolean; lastChecked: string; progress: number;
}
export async function startupStatus(): Promise<StartupStatus> { return (await preferences()).StartupStatus(nativePageToken()); }
export async function setStartup(enabled: boolean): Promise<StartupStatus> { return (await preferences()).StartupSetEnabled(nativePageToken(), enabled); }
export async function updateStatus(): Promise<UpdateStatus> { return (await updates()).Status(nativePageToken()); }
export async function checkUpdates(): Promise<UpdateStatus> { return (await updates()).Check(nativePageToken()); }
export async function downloadUpdate(): Promise<UpdateStatus> { return (await updates()).Download(nativePageToken()); }
export async function cancelUpdate(): Promise<void> { return (await updates()).Cancel(nativePageToken()); }
export async function restartForUpdate(): Promise<void> { return (await updates()).Restart(nativePageToken()); }
export async function setAutomaticUpdates(enabled: boolean): Promise<UpdateStatus> { return (await updates()).SetAutomatic(nativePageToken(), enabled); }
export async function onUpdateStatus(handler: (status: UpdateStatus) => void): Promise<() => void> {
  const { Events } = await import('@wailsio/runtime');
  return Events.On('bc-desktop-updates', event => {
    const value = event.data as UpdateStatus;
    if (value && typeof value.state === 'string' && typeof value.available === 'boolean') handler(value);
  });
}

let activities = 0;
let releaseActivity: (() => void) | undefined;

/** One shared lease protects page-owned media without one timer per track/task. */
export function beginDesktopActivity(): () => void {
  if (getDesktopRuntime() !== 'wails') return () => {};
  activities++;
  releaseActivity ??= startActivityLease();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--activities === 0) { releaseActivity?.(); releaseActivity = undefined; }
  };
}

function startActivityLease(): () => void {
  const id = crypto.randomUUID();
  let stopped = false;
  let pending: Promise<void> | undefined;
  const pulse = () => {
    if (stopped || pending) return;
    pending = updates().then(api => api.Activity(nativePageToken(), id, true)).catch(() => {}).finally(() => { pending = undefined; });
  };
  pulse();
  const timer = setInterval(pulse, 3000);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    void (pending ?? Promise.resolve()).then(async () => (await updates()).Activity(nativePageToken(), id, false)).catch(() => {});
  };
}
