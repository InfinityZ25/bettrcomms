import { useState } from 'react';
import { Bell, Clock } from 'lucide-react';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { cancelMessageReminder, setMessageReminder } from './personalStore';
import {
  localDateTimeValue,
  presetTime,
  validFutureTime,
  type ReminderPreset,
} from './time';

export default function ReminderPicker({
  roomId,
  messageId,
  onClose,
  existing,
}: {
  roomId: string;
  messageId: string;
  onClose: () => void;
  existing?: string;
}) {
  const [when, setWhen] = useState(() =>
    localDateTimeValue(existing ? new Date(existing) : presetTime('hour')),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lifetime = useLifetimeSignal();
  const date = validFutureTime(when);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const presets: { id: ReminderPreset; label: string }[] = [
    { id: 'hour', label: 'In one hour' },
    { id: 'tonight', label: 'Tonight · 20:00' },
    { id: 'tomorrow', label: 'Tomorrow · 09:00' },
  ];
  async function save() {
    if (!date || busy) return;
    const signal = lifetime();
    setBusy(true);
    setError('');
    try {
      await setMessageReminder(roomId, messageId, date);
      if (!signal.aborted) onClose();
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not set reminder.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  async function cancel() {
    if (busy) return;
    const signal = lifetime();
    setBusy(true);
    setError('');
    try {
      await cancelMessageReminder(roomId, messageId);
      if (!signal.aborted) onClose();
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not cancel reminder.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={existing ? 'Reschedule reminder' : 'Remind me to reply'}
      description="Your reminder is private. Opening or replying to the message does not mark it done."
      className="sm:max-w-md"
    >
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <Button
            key={preset.id}
            variant="outline"
            size="sm"
            className="min-h-11"
            disabled={busy}
            onClick={() => setWhen(localDateTimeValue(presetTime(preset.id)))}
          >
            <Clock size={14} />
            {preset.label}
          </Button>
        ))}
      </div>
      <label
        className="mt-4 flex flex-col gap-2 text-sm"
        htmlFor="message-reminder-time"
      >
        Date and time
        <Input
          id="message-reminder-time"
          type="datetime-local"
          value={when}
          disabled={busy}
          className="min-h-11 w-full min-w-0"
          onChange={(event) => setWhen(event.target.value)}
        />
      </label>
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        {date
          ? `${date.toLocaleString()} · ${timezone}`
          : 'Choose a date and time in the future.'}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {existing && (
          <Button
            variant="ghost"
            className="mr-auto min-h-11"
            disabled={busy}
            onClick={() => void cancel()}
          >
            Cancel reminder
          </Button>
        )}
        <Button
          variant="ghost"
          className="min-h-11"
          disabled={busy}
          onClick={onClose}
        >
          Back
        </Button>
        <Button
          className="min-h-11"
          disabled={busy || !date}
          onClick={() => void save()}
        >
          <Bell size={16} />
          {busy ? 'Saving…' : existing ? 'Update reminder' : 'Set reminder'}
        </Button>
      </div>
    </AppDialog>
  );
}
