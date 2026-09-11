import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { readTalkSettings } from '@/media/pushToTalk';
import { readCopilotSettings, writeCopilotSettings, type CopilotSettings } from '@/media/visualCopilot';
import { useMountEffect } from '@/hooks/useMountEffect';
import { SettingRow } from './SettingRow';
import { SettingsSelect } from './SettingsControls';
import '@/features/call/VisualCopilot.css';

export function useCopilotSettings() {
  const [settings, setSettings] = useState(readCopilotSettings);
  useMountEffect(() => {
    const update = () => setSettings(readCopilotSettings());
    window.addEventListener('bc-visual-copilot', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('bc-visual-copilot', update);
      window.removeEventListener('storage', update);
    };
  });
  return settings;
}

export default function VisualCopilotSettings() {
  const settings = useCopilotSettings();
  const [error, setError] = useState('');
  function save(patch: Partial<CopilotSettings>) {
    try {
      const next = { ...settings, ...patch };
      const talk = readTalkSettings();
      if (next.pingKey && next.pingKey === next.snapshotKey) throw new Error('Choose a different shortcut for each action.');
      if (talk.enabled && talk.binding.kind === 'keyboard' && [next.pingKey, next.snapshotKey].includes(talk.binding.code)) throw new Error('That shortcut is already used for push-to-talk.');
      writeCopilotSettings(next);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this setting.');
    }
  }
  const sizes = [{ value: 24, label: 'Small' }, { value: 40, label: 'Medium' }, { value: 56, label: 'Large' }];
  const cardSizes = [{ value: 240, label: 'Small' }, { value: 320, label: 'Medium' }, { value: 400, label: 'Large' }];
  const shortcuts = [{ value: '', label: 'None' }, ...['KeyP', 'KeyG', 'KeyJ', 'KeyK', 'F6', 'F7', 'F8', 'F9'].map((value) => ({ value, label: value.replace('Key', '') }))];

  return (
    <section className="copilot-settings device-settings__card" aria-label="Visual copilot settings">
      <h3>Shared-screen reactions</h3>
      <SettingRow as="div" title="Allow reactions" description="Let friends point something out while you share." control={<Switch aria-label="Enable visual copilot on this device" checked={settings.enabled} onCheckedChange={(enabled) => save({ enabled })} />} />
      <div className="copilot-settings-toggles">
        <SettingRow as="div" title="Pointers" description="Show quick signals." control={<Switch aria-label="Receive quick signals" checked={settings.showPings} onCheckedChange={(showPings) => save({ showPings })} />} />
        <SettingRow as="div" title="Marked captures" description="Show frames your friends mark up." control={<Switch aria-label="Receive marked captures" checked={settings.showCards} onCheckedChange={(showCards) => save({ showCards })} />} />
        <SettingRow as="div" title="Motion" description="Animate incoming signals." control={<Switch aria-label="Animate signals" checked={settings.animate} onCheckedChange={(animate) => save({ animate })} />} />
      </div>
      <div className="copilot-settings-grid">
        <label>Signal duration<SettingsSelect ariaLabel="Signal duration" value={settings.duration} onValueChange={(value) => save({ duration: Number(value) })} options={[1, 2, 4].map((value) => ({ value, label: `${value} second${value === 1 ? '' : 's'}` }))} /></label>
        <label>Signal size<SettingsSelect ariaLabel="Signal size" value={settings.size} onValueChange={(value) => save({ size: Number(value) })} options={sizes} /></label>
        <label>Capture corner<SettingsSelect ariaLabel="Capture corner" value={settings.corner} onValueChange={(corner) => save({ corner: corner as CopilotSettings['corner'] })} options={[{ value: 'top-left', label: 'Top left' }, { value: 'top-right', label: 'Top right' }, { value: 'bottom-left', label: 'Bottom left' }, { value: 'bottom-right', label: 'Bottom right' }]} /></label>
        <label>Capture size<SettingsSelect ariaLabel="Capture size" value={settings.cardWidth} onValueChange={(value) => save({ cardWidth: Number(value) })} options={cardSizes} /></label>
        <label>Close captures<SettingsSelect ariaLabel="Close captures" value={settings.cardSeconds} onValueChange={(value) => save({ cardSeconds: Number(value) })} options={[{ value: 5, label: 'After 5 seconds' }, { value: 15, label: 'After 15 seconds' }, { value: 30, label: 'After 30 seconds' }, { value: 0, label: 'Manually' }]} /></label>
        <label>Point shortcut<SettingsSelect ariaLabel="Point shortcut" value={settings.pingKey} onValueChange={(pingKey) => save({ pingKey })} options={shortcuts} /></label>
        <label>Capture shortcut<SettingsSelect ariaLabel="Freeze shortcut" value={settings.snapshotKey} onValueChange={(snapshotKey) => save({ snapshotKey })} options={shortcuts} /></label>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
