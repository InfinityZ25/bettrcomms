import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { readDesktopBootReport } from '@/desktop/runtime';
import { useMountEffect } from '@/hooks/useMountEffect';
import { SettingRow } from './SettingRow';

export default function TrayPreference() {
  const token = readDesktopBootReport()?.pageToken;
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useMountEffect(() => {
    if (!token) return;
    let active = true;
    void import('@/desktop/wailsbindings/bettercomms/desktop-wails/trayservice').then(async ({ Enabled }) => {
      const saved = await Enabled(token);
      if (active) { setEnabled(saved); setReady(true); }
    }).catch(() => { if (active) setError('Could not read the desktop tray setting.'); });
    return () => { active = false; };
  });
  if (!token) return null;
  return <>
    <SettingRow as="div" title="Keep running in the tray" description="Closing the desktop window keeps BetterComms running and receiving alerts. Use Quit from the tray menu to exit." control={<Switch aria-label="Keep running in the tray" checked={enabled} disabled={!ready} onCheckedChange={(next) => {
      void import('@/desktop/wailsbindings/bettercomms/desktop-wails/trayservice').then(async ({ SetEnabled }) => {
        await SetEnabled(token, next);
        setEnabled(next);
        setError('');
      }).catch(() => setError('Could not save the desktop tray setting.'));
    }} />} />
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </>;
}
