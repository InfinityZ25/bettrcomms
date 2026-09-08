import { useState } from 'react';
import { isNativePushToTalk } from '@/media/nativePushToTalk';
import { canBindKey, readTalkSettings, talkBindingLabel, writeTalkSettings, type TalkBinding, type TalkSettings } from '@/media/pushToTalk';

export default function PushToTalkSettings() {
  const [settings, setSettings] = useState(readTalkSettings);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState('');
  function save(next: TalkSettings) {
    try {
      writeTalkSettings(next);
      setSettings(next);
      setError('');
    } catch { setError('Could not save push-to-talk. Allow local storage and try again.'); }
  }
  function assign(next: TalkBinding) {
    save({ ...settings, binding: next });
    setBinding(false);
  }
  return (
    <div className="device-settings__card push-to-talk-settings" data-talk-binding>
      <label className="push-to-talk-settings__toggle">
        <span>Push-to-talk</span>
        <input type="checkbox" checked={settings.enabled} onChange={event => {
          setBinding(false);
          save({ ...settings, enabled: event.target.checked });
        }} />
      </label>
      <p>Hold your shortcut to speak in calls. Waiting keeps your microphone ready and is separate from mute. Off by default. Mute and deafen always take priority.</p>
      <label className="push-to-talk-settings__toggle">
        <span>Allow push-to-talk while typing in BetterComms</span>
        <input type="checkbox" checked={settings.allowWhileTyping === true} disabled={!settings.enabled}
          onChange={event => save({ ...settings, allowWhileTyping: event.target.checked })} />
      </label>
      <p>Applies to every assigned shortcut inside BetterComms. Text and editing shortcuts keep working. Input in other applications is unchanged. Shortcut assignment always pauses push-to-talk.</p>
      <button
        type="button"
        className="text-button"
        disabled={!settings.enabled}
        aria-label="Set push-to-talk shortcut"
        onClick={() => {
          if (binding) assign({ kind: 'mouse', button: 0 });
          else setBinding(true);
        }}
        onBlur={() => setBinding(false)}
        onKeyDown={event => {
          if (!binding) return;
          event.stopPropagation();
          if (event.code === 'Tab') { setBinding(false); return; }
          event.preventDefault();
          if (event.code === 'Escape') { setBinding(false); return; }
          if (!event.repeat && !event.nativeEvent.isComposing && canBindKey(event.code)) assign({ kind: 'keyboard', code: event.code });
        }}
        onMouseDown={event => {
          if (!binding || event.button === 0) return;
          event.preventDefault();
          event.stopPropagation();
          assign({ kind: 'mouse', button: event.button });
        }}
        onMouseUp={event => event.preventDefault()}
        onContextMenu={event => event.preventDefault()}
        onAuxClick={event => event.preventDefault()}
      >
        {binding ? 'Press a key or mouse button here…' : `Shortcut: ${talkBindingLabel(settings.binding)}`}
      </button>
      <p role="status">{binding ? 'Escape cancels. Tab and the Windows/Command key are reserved.' : isNativePushToTalk() ? 'On Windows, your shortcut works during calls even with another app focused or BetterComms minimized. Other platforms use the focused-window shortcut.' : 'Keep BetterComms focused. For global keyboard and mouse shortcuts while gaming, use the Windows desktop app.'}</p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
