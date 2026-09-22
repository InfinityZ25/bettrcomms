import { useState } from 'react';
import { isNativePushToTalk } from '@/media/nativePushToTalk';
import { canBindKey, readTalkSettings, talkBindingLabel, writeTalkSettings, type TalkBinding, type TalkSettings } from '@/media/pushToTalk';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

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
      <div className="push-to-talk-settings__toggle">
        <span>Push-to-talk</span>
        <Switch aria-label="Push-to-talk" checked={settings.enabled} onCheckedChange={enabled => {
          setBinding(false);
          save({ ...settings, enabled });
        }} />
      </div>
      <p>Hold a shortcut when you want to speak.</p>
      <div className="push-to-talk-settings__toggle">
        <span>Allow while typing</span>
        <Switch aria-label="Allow push-to-talk while typing in BetterComms" checked={settings.allowWhileTyping === true} disabled={!settings.enabled}
          onCheckedChange={allowWhileTyping => save({ ...settings, allowWhileTyping })} />
      </div>
      <p>Your shortcut keeps working while you type in BetterComms.</p>
      <Button
        variant="secondary"
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
      </Button>
      <p role="status">{binding ? 'Press Escape to cancel.' : isNativePushToTalk() ? 'This shortcut also works while BetterComms is in the background.' : 'Keep BetterComms focused to use this shortcut.'}</p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
