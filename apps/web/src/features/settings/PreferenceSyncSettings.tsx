import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { accountPreferencesSnapshot, reconcileAccountPreferences, setPreferenceSync, subscribeAccountPreferences } from './accountPreferences';
import { SettingRow } from './SettingRow';

export default function PreferenceSyncSettings({ userId }: { userId: string }) {
  const sync = useSyncExternalStore(subscribeAccountPreferences, accountPreferencesSnapshot);
  const current = sync.userId === userId;
  return <div className="space-y-2">
    <SettingRow as="div" title="Sync preferences on this device" description="Share theme, camera placement, voice balancing and app sounds across devices you opt in. Microphone, camera, shortcuts, permissions and quiet notifications stay on each device." control={<Switch aria-label="Sync preferences" checked={current && sync.enabled} disabled={!current} onCheckedChange={setPreferenceSync} />} />
    {current && sync.enabled && <p className="text-xs text-muted-foreground" role="status">{sync.error || (sync.busy ? 'Syncing your preferences…' : sync.ready ? 'Preferences are up to date.' : 'Waiting to sync.')}</p>}
    {current && sync.enabled && sync.error && <Button size="sm" variant="outline" disabled={sync.busy} onClick={() => { void reconcileAccountPreferences(); }}>Retry preference sync</Button>}
  </div>;
}
