import { useState } from 'react';
import { Bell, CalendarDays, Check } from 'lucide-react';
import type { User } from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { api, type ChannelEventReminder } from './activityApi';
import { subscribeActivityEvents } from './activityEvents';
import {
  callPresenceSnapshot,
  subscribeCallPresence,
} from '@/features/call/useCallPresence';

export function ActivityReminderInbox({
  user,
  onOpenRoom,
}: {
  user: User;
  onOpenRoom?: (roomId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reminders, setReminders] = useState<ChannelEventReminder[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const lifetime = useLifetimeSignal();
  async function load() {
    const signal = lifetime();
    try {
      const result = await api<{ reminders: ChannelEventReminder[] }>(
        '/me/event-reminders',
        undefined,
        undefined,
        signal,
      );
      if (!signal.aborted) {
        setReminders(result.reminders);
        setError('');
      }
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not load reminders.',
        );
    }
  }
  useMountEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 60000);
    const off = subscribeActivityEvents((event) => {
      if (
        event.type === 'channel.activity' &&
        event.kind === 'scheduled-events'
      )
        void load();
    });
    let previous = callPresenceSnapshot();
    const offPresence = subscribeCallPresence(() => {
      const next = callPresenceSnapshot();
      if (
        next.userId === user.id &&
        (next.syncRevision !== previous.syncRevision ||
          next.roomsRevision !== previous.roomsRevision)
      )
        void load();
      previous = next;
    });
    return () => {
      clearInterval(timer);
      off();
      offPresence();
    };
  });
  async function dismiss(id: string) {
    if (busy) return;
    const signal = lifetime();
    setBusy(id);
    try {
      await api(`/me/event-reminders/${id}`, undefined, 'DELETE', signal);
      if (!signal.aborted)
        setReminders((items) => items.filter((item) => item.id !== id));
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not dismiss reminder.',
        );
    } finally {
      if (!signal.aborted) setBusy('');
    }
  }
  return (
    <>
      <Button
        size="icon-sm"
        variant={reminders.length ? 'secondary' : 'ghost'}
        aria-label={`Event reminders${reminders.length ? `, ${reminders.length} unread` : ''}`}
        onClick={() => {
          setOpen(true);
          void load();
        }}
        className="relative shrink-0 max-[820px]:size-11"
      >
        <Bell size={16} />
        {reminders.length > 0 && (
          <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
            {reminders.length}
          </span>
        )}
      </Button>
      {reminders.length > 0 && !open && (
        <span role="status" className="sr-only">
          {reminders[0].title} starts{' '}
          {new Date(reminders[0].starts_at).toLocaleTimeString()}.
        </span>
      )}
      {open && (
        <AppDialog
          open
          onOpenChange={setOpen}
          title="Event reminders"
          description="Going and Maybe events appear 10 minutes before. Unread reminders survive reconnects and reloads."
          className="max-h-[80dvh] overflow-y-auto sm:max-w-lg"
        >
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </p>
          )}
          {!reminders.length && (
            <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-muted-foreground">
              <CalendarDays size={26} />
              <p className="text-sm">No events due yet.</p>
            </div>
          )}
          <ul className="space-y-3">
            {reminders.map((reminder) => (
              <li
                key={reminder.id}
                className="rounded-xl border border-primary/25 bg-primary/5 p-4"
              >
                <h3 className="font-medium">{reminder.title}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {reminder.room_name} ·{' '}
                  <time dateTime={reminder.starts_at}>
                    {new Date(reminder.starts_at).toLocaleString()}
                  </time>
                </p>
                <div className="mt-3 flex gap-2">
                  {onOpenRoom && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onOpenRoom(reminder.room_id);
                        setOpen(false);
                      }}
                    >
                      Open channel
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={() => void dismiss(reminder.id)}
                  >
                    <Check size={14} />
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </AppDialog>
      )}
    </>
  );
}
