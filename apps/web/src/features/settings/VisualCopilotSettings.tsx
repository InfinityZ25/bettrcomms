import { useState } from 'react';
import { readTalkSettings } from '@/media/pushToTalk';
import { readCopilotSettings, writeCopilotSettings, type CopilotSettings } from '@/media/visualCopilot';
import { useMountEffect } from '@/hooks/useMountEffect';
import '@/features/call/VisualCopilot.css';

export function useCopilotSettings() {
  const [settings, setSettings] = useState(readCopilotSettings);
  useMountEffect(() => {
    const update = () => setSettings(readCopilotSettings());
    window.addEventListener('bc-visual-copilot', update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener('bc-visual-copilot', update); window.removeEventListener('storage', update); };
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
      if (next.pingKey && next.pingKey === next.snapshotKey) throw new Error('Choose different shortcuts for each action.');
      if (talk.enabled && talk.binding.kind === 'keyboard' && [next.pingKey, next.snapshotKey].includes(talk.binding.code)) throw new Error('That shortcut is assigned to push-to-talk.');
      writeCopilotSettings(next); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save preferences.'); }
  }
  return <section className="copilot-settings device-settings__card" aria-label="Visual copilot settings">
    <h3>Visual copilot</h3>
    <label><input type="checkbox" checked={settings.enabled} onChange={e => save({ enabled: e.target.checked })} /> Enable visual copilot on this device</label>
    <p>Let friends point at your stream or send a marked frame. Choose who is allowed each time you share.</p>
    <div className="copilot-settings-toggles">
      <label><input type="checkbox" checked={settings.showPings} onChange={e => save({ showPings: e.target.checked })} /> Receive quick signals</label>
      <label><input type="checkbox" checked={settings.showCards} onChange={e => save({ showCards: e.target.checked })} /> Receive marked captures</label>
      <label><input type="checkbox" checked={settings.animate} onChange={e => save({ animate: e.target.checked })} /> Animate signals</label>
    </div>
    <div className="copilot-settings-grid">
      <label>Signal duration<select value={settings.duration} onChange={e => save({ duration: +e.target.value })}>{[1, 2, 4].map(n => <option key={n} value={n}>{n} seconds</option>)}</select></label>
      <label>Signal size<select value={settings.size} onChange={e => save({ size: +e.target.value })}>{[24, 40, 56].map((n, i) => <option key={n} value={n}>{['Small', 'Medium', 'Large'][i]}</option>)}</select></label>
      <label>Capture corner<select value={settings.corner} onChange={e => save({ corner: e.target.value as CopilotSettings['corner'] })}>{(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map(c => <option key={c} value={c}>{c.replace('-', ' ')}</option>)}</select></label>
      <label>Capture size<select value={settings.cardWidth} onChange={e => save({ cardWidth: +e.target.value })}>{[240, 320, 400].map((n, i) => <option key={n} value={n}>{['Small', 'Medium', 'Large'][i]}</option>)}</select></label>
      <label>Close captures<select value={settings.cardSeconds} onChange={e => save({ cardSeconds: +e.target.value })}>{[5, 15, 30].map(n => <option key={n} value={n}>After {n} seconds</option>)}<option value={0}>Manually (maximum 1 minute)</option></select></label>
      {(['pingKey', 'snapshotKey'] as const).map(key => <label key={key}>{key === 'pingKey' ? 'Point shortcut' : 'Freeze shortcut'}<select value={settings[key]} onChange={e => save({ [key]: e.target.value })}><option value="">None</option>{['KeyP', 'KeyG', 'KeyJ', 'KeyK', 'F6', 'F7', 'F8', 'F9'].map(code => <option key={code} value={code}>{code.replace('Key', '')}</option>)}</select></label>)}
    </div>
    <p>Shortcuts work while the shared video is focused. Typing and push-to-talk take priority. Windows overlays require native sharing; browsers show indications inside BetterComms.</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
