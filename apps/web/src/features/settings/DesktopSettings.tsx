import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useMountEffect } from '@/hooks/useMountEffect';
import { startupStatus, setStartup, updateStatus, checkUpdates, downloadUpdate, cancelUpdate, restartForUpdate, setAutomaticUpdates, onUpdateStatus, type StartupStatus, type UpdateStatus } from '@/desktop/desktopSettings';
import { nativeShortcutPermission } from '@/desktop/nativeMedia';
import { canBindKey, readTalkSettings, talkBindingLabel, type TalkBinding } from '@/media/pushToTalk';
import { readCallShortcuts, writeCallShortcuts, sameShortcut, type CallShortcutSettings } from '@/media/callShortcutSettings';
import { SettingRow } from './SettingRow';
import { SettingsSection } from './SettingsSection';

function ShortcutField({ title, value, onChange, disabled }: { title: string; value?: TalkBinding; onChange: (value?: TalkBinding) => void; disabled: boolean }) {
  const [assigning, setAssigning] = useState(false);
  function assign(binding: TalkBinding) { setAssigning(false); onChange(binding); }
  return <div className="flex flex-wrap items-center gap-2" data-talk-binding>
    <Button aria-label={'Set ' + title + ' shortcut'} variant="outline" disabled={disabled} onClick={() => {
      if (assigning) assign({ kind: 'mouse', button: 0 }); else setAssigning(true);
    }} onBlur={() => setAssigning(false)} onKeyDown={event => {
      if (!assigning) return;
      event.stopPropagation();
      if (event.code === 'Tab') { setAssigning(false); return; }
      event.preventDefault();
      if (event.code === 'Escape') { setAssigning(false); return; }
      if (!event.repeat && !event.nativeEvent.isComposing && canBindKey(event.code)) assign({ kind: 'keyboard', code: event.code });
    }} onMouseDown={event => {
      if (!assigning || event.button === 0) return;
      event.preventDefault(); event.stopPropagation(); assign({ kind: 'mouse', button: event.button });
    }} onContextMenu={event => event.preventDefault()} onAuxClick={event => event.preventDefault()}>
      {assigning ? 'Press a key or mouse button…' : value ? talkBindingLabel(value) : 'Not assigned'}
    </Button>
    {value && <Button variant="ghost" disabled={disabled} aria-label={'Clear ' + title + ' shortcut'} onClick={() => onChange(undefined)}>Clear</Button>}
  </div>;
}

export default function DesktopSettings() {
  const [startup, setStartupStatus] = useState<StartupStatus>();
  const [update, setUpdate] = useState<UpdateStatus>();
  const [permission, setPermission] = useState<{ available: boolean; granted: boolean; detail: string }>();
  const [shortcuts, setShortcuts] = useState(readCallShortcuts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  useMountEffect(() => {
    mounted.current = true;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void Promise.allSettled([startupStatus(), updateStatus(), nativeShortcutPermission()]).then(results => {
      if (!active) return;
      if (results[0].status === 'fulfilled') setStartupStatus(results[0].value);
      if (results[1].status === 'fulfilled') setUpdate(results[1].value);
      if (results[2].status === 'fulfilled') setPermission(results[2].value);
      if (results.some(result => result.status === 'rejected')) setError('Some desktop settings could not be loaded. Restart BetterComms and try again.');
    });
    void onUpdateStatus(value => { if (active) setUpdate(value); }).then(stop => { if (active) unsubscribe = stop; else stop(); }).catch(() => {});
    return () => { active = false; mounted.current = false; unsubscribe?.(); };
  });
  async function perform<T>(operation: () => Promise<T>, apply?: (result: T) => void) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await operation();
      if (mounted.current) apply?.(result);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : 'The desktop action could not be completed.');
    } finally { if (mounted.current) setBusy(false); }
  }
  function saveShortcuts(next: CallShortcutSettings) {
    try {
      const talk = readTalkSettings();
      if (talk.enabled && (sameShortcut(talk.binding, next.mute) || sameShortcut(talk.binding, next.deafen))) throw new Error('Push-to-talk, mute and deafen need different shortcuts.');
      writeCallShortcuts(next); setShortcuts(next); setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save shortcuts.'); }
  }
  const downloading = update?.state === 'downloading';
  return <SettingsSection id="settings-desktop" title="Desktop">
    <SettingRow as="div" title="Start with the system" description={startup?.detail || 'Open BetterComms when you sign in to Windows or macOS. Off by default.'}
      control={<Switch aria-label="Start BetterComms with the system" checked={startup?.enabled ?? false} disabled={busy || !startup?.available}
        onCheckedChange={enabled => { void perform(() => setStartup(enabled), setStartupStatus); }} />} />
    <SettingRow as="div" title="Global call shortcuts" description={permission?.detail || 'Keyboard and mouse shortcuts work during calls, including while another app is focused. Input is never blocked in other apps.'}
      control={permission?.available && !permission.granted ? <Button disabled={busy} onClick={() => { void perform(() => nativeShortcutPermission(true), setPermission); }}>Allow input monitoring</Button> : <span className="text-xs text-muted-foreground">{permission?.granted ? 'Permission ready' : 'Unavailable'}</span>} />
    <SettingRow as="div" title="Toggle microphone mute" description="Press once to mute or unmute. Overrides push-to-talk."
      control={<ShortcutField title="mute" value={shortcuts.mute} disabled={!permission?.available} onChange={mute => saveShortcuts({ ...shortcuts, mute })} />} />
    <SettingRow as="div" title="Toggle deafen" description="Press once to pause or restore listening and microphone transmission."
      control={<ShortcutField title="deafen" value={shortcuts.deafen} disabled={!permission?.available} onChange={deafen => saveShortcuts({ ...shortcuts, deafen })} />} />
    <p className="text-xs text-muted-foreground">Shortcuts pause while assigning a key. While typing in BetterComms, they follow “Allow while typing” in Voice &amp; devices. Choose a key other than Escape, Tab or the Windows/Command key.</p>
    <SettingRow as="div" title="Check updates automatically" description="Check at most every six hours while the app is running. Downloads and restart require your action."
      control={<Switch aria-label="Check desktop updates automatically" checked={update?.automatic ?? false} disabled={busy || !update?.available}
        onCheckedChange={enabled => { void perform(() => setAutomaticUpdates(enabled), setUpdate); }} />} />
    <div className="space-y-3 rounded-lg border border-border p-4">
      <p className="text-sm font-medium">BetterComms {update?.currentVersion || 'desktop'}{update?.version ? ' → ' + update.version : ''}</p>
      <p role="status" className="text-sm text-muted-foreground">{update?.detail || 'Loading update status…'}</p>
      {update?.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{update.notes}</p>}
      {downloading && <progress aria-label="Update download progress" className="w-full" value={update.progress} max={1} />}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || !update?.available || downloading || update?.state === 'restarting'} onClick={() => { void perform(checkUpdates, setUpdate); }}>Check for updates</Button>
        {update?.state === 'available' && <Button disabled={busy} onClick={() => { void perform(downloadUpdate, setUpdate); }}>Download update</Button>}
        {downloading && <Button variant="outline" onClick={() => { void cancelUpdate().catch(() => { if (mounted.current) setError('Could not cancel the download.'); }); }}>Cancel download</Button>}
        {update?.state === 'ready' && <Button disabled={busy} onClick={() => { void perform(restartForUpdate); }}>Restart to install</Button>}
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </SettingsSection>;
}
