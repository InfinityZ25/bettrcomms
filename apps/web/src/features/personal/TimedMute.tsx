import { useState, useSyncExternalStore } from 'react';
import { Bell, BellOff, Clock } from 'lucide-react';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  notificationPolicyTime,
  notificationSnapshot,
  setRoomTimedMute,
  subscribeNotifications,
} from '@/features/chat/notificationSettings';
import { localDateTimeValue, presetTime, validFutureTime } from './time';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';

export function TimedMuteMenuItems({
  roomId,
  context = false,
  onCustom,
  onError,
}: {
  roomId: string;
  context?: boolean;
  onCustom: () => void;
  onError: (error: string) => void;
}) {
  const notifications = useSyncExternalStore(
    subscribeNotifications,
    notificationSnapshot,
  );
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const until = notifications.mutedUntil[roomId];
  function mute(preset: 'hour' | 'eight-hours' | 'tomorrow') {
    void setRoomTimedMute(roomId, presetTime(preset)).catch((error) =>
      onError(
        error instanceof Error ? error.message : 'Could not mute conversation.',
      ),
    );
  }
  return (
    <>
      <Item className="min-h-11" onClick={() => mute('hour')}>
        <Clock />
        Mute for one hour
      </Item>
      <Item className="min-h-11" onClick={() => mute('eight-hours')}>
        <Clock />
        Mute for eight hours
      </Item>
      <Item className="min-h-11" onClick={() => mute('tomorrow')}>
        <Clock />
        Mute until tomorrow · 09:00
      </Item>
      <Item className="min-h-11" onClick={onCustom}>
        <Clock />
        Mute until…
      </Item>
      {until && (
        <Item
          className="min-h-11"
          onClick={() => {
            void setRoomTimedMute(roomId, null).catch((error) =>
              onError(
                error instanceof Error
                  ? error.message
                  : 'Could not resume notifications.',
              ),
            );
          }}
        >
          <Bell />
          Resume timed mute
        </Item>
      )}
    </>
  );
}
export function TimedMuteIndicator({ roomId }: { roomId: string }) {
  const notifications = useSyncExternalStore(
    subscribeNotifications,
    notificationSnapshot,
  );
  const until = notifications.mutedUntil[roomId];
  if (!until || Date.parse(until) <= notificationPolicyTime(notifications))
    return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
      title={`Muted until ${new Date(until).toLocaleString()}`}
      aria-label={`Muted until ${new Date(until).toLocaleString()}`}
    >
      <BellOff size={14} />
    </span>
  );
}
export function TimedMuteDialog({
  roomId,
  onClose,
}: {
  roomId: string;
  onClose: () => void;
}) {
  const [when, setWhen] = useState(() =>
    localDateTimeValue(presetTime('hour')),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lifetime = useLifetimeSignal();
  const date = validFutureTime(when);
  async function save() {
    if (!date || busy) return;
    const signal = lifetime();
    setBusy(true);
    setError('');
    try {
      await setRoomTimedMute(roomId, date);
      if (!signal.aborted) onClose();
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not mute conversation.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <AppDialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
      title="Mute until"
      description="Pause message and call alerts across your devices. Your usual notification mode resumes afterward."
      className="sm:max-w-md"
    >
      <label className="flex flex-col gap-2 text-sm" htmlFor="timed-mute-date">
        Date and time
        <Input
          id="timed-mute-date"
          className="min-h-11 min-w-0"
          type="datetime-local"
          value={when}
          onChange={(event) => setWhen(event.target.value)}
          disabled={busy}
        />
      </label>
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        {date
          ? `${date.toLocaleString()} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
          : 'Choose a future time.'}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="ghost"
          className="min-h-11"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          className="min-h-11 bc-glow"
          disabled={!date || busy}
          onClick={() => void save()}
        >
          <BellOff size={16} />
          {busy ? 'Saving…' : 'Mute alerts'}
        </Button>
      </div>
    </AppDialog>
  );
}
