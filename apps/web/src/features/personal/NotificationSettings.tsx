import { useState, useSyncExternalStore } from 'react';
import { Bell, Moon, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SettingRow } from '@/features/settings/SettingRow';
import { SettingsSection } from '@/features/settings/SettingsSection';
import TrayPreference from '@/features/settings/TrayPreference';
import { getDesktopRuntime } from '@/desktop/runtime';
import {
  notificationSnapshot,
  refreshNotificationPolicy,
  saveQuietHours,
  setDoNotDisturb,
  setSystemNotifications,
  subscribeNotifications,
} from '@/features/chat/notificationSettings';
import type { QuietHours, QuietSchedule } from './api';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';

export default function NotificationSettings() {
  const state = useSyncExternalStore(
    subscribeNotifications,
    notificationSnapshot,
  );
  const desktop = getDesktopRuntime() === 'wails';
  return (
    <SettingsSection id="settings-notifications" title="Notifications">
      <SettingRow
        as="div"
        title="Quiet notifications on this device"
        description="Pause message and incoming call alerts here. Your account availability stays unchanged."
        control={
          <Switch
            aria-label="Do not disturb"
            checked={state.localDnd}
            onCheckedChange={setDoNotDisturb}
          />
        }
      />
      <SettingRow
        as="div"
        title={desktop ? 'Desktop notifications' : 'Browser notifications'}
        description={
          state.error ||
          (desktop
            ? 'Receive alerts while BetterComms is running. Keep it in the tray to receive alerts after closing its window.'
            : state.background
              ? 'Alerts also arrive after you close this browser tab.'
              : 'Receive alerts while away. Web Push also works after closing the tab when available.')
        }
        control={
          <Switch
            aria-label={
              desktop ? 'Desktop notifications' : 'Browser notifications'
            }
            checked={state.alerts}
            disabled={!desktop && !('Notification' in window)}
            onCheckedChange={(enabled) => {
              void setSystemNotifications(enabled);
            }}
          />
        }
      />
      {state.accountDnd && (
        <p className="text-xs text-muted-foreground">
          Your account is set to Do not disturb. Change your availability in
          Profile to resume alerts.
        </p>
      )}
      {state.quiet ? (
        <QuietHoursForm quiet={state.quiet} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Loading account notification settings…
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => void refreshNotificationPolicy()}
          >
            <RefreshCw size={14} />
            Retry
          </Button>
        </p>
      )}
      {desktop && <TrayPreference />}
    </SettingsSection>
  );
}
function scheduleFor(quiet: QuietHours): QuietSchedule {
  return {
    enabled: quiet.enabled,
    timezone:
      quiet.version === 0
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : quiet.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekdays: quiet.weekdays.length ? quiet.weekdays : [0, 1, 2, 3, 4, 5, 6],
    start_time: quiet.start_time || '23:00',
    end_time: quiet.end_time || '08:00',
  };
}
function QuietHoursForm({ quiet }: { quiet: QuietHours }) {
  const [draft, setDraft] = useState(() => scheduleFor(quiet));
  const [version, setVersion] = useState(quiet.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const lifetime = useLifetimeSignal();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const changedElsewhere = version !== quiet.version;
  function edit(patch: Partial<QuietSchedule>) {
    setDraft((value) => ({ ...value, ...patch }));
    setSaved(false);
    setError('');
  }
  async function save() {
    if (busy) return;
    const signal = lifetime();
    setBusy(true);
    setSaved(false);
    setError('');
    try {
      await saveQuietHours(draft, version);
      if (!signal.aborted) {
        setVersion(notificationSnapshot().quiet?.version ?? version);
        setSaved(true);
      }
    } catch (failure) {
      if (!signal.aborted) {
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not save quiet hours.',
        );
        void refreshNotificationPolicy();
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="space-y-3 rounded-2xl bc-card p-4"
      aria-label="Quiet hours"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-heading inline-flex items-center gap-2 text-base font-bold">
            <Moon size={16} />
            Quiet hours
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Silence messages and incoming calls on every device. Days refer to
            when the quiet period starts; overnight schedules end the following
            day.
          </p>
        </div>
        <Switch
          aria-label="Enable quiet hours"
          checked={draft.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => edit({ enabled })}
        />
      </div>
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label="Quiet hours days"
      >
        {days.map((day, index) => (
          <Button
            key={day}
            type="button"
            variant={draft.weekdays.includes(index) ? 'secondary' : 'outline'}
            size="sm"
            className="min-h-11 min-w-11 rounded-full aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:ring-1 aria-pressed:ring-primary/40 aria-pressed:hover:bg-primary/20"
            disabled={busy}
            aria-pressed={draft.weekdays.includes(index)}
            onClick={() =>
              edit({
                weekdays: draft.weekdays.includes(index)
                  ? draft.weekdays.filter((value) => value !== index)
                  : [...draft.weekdays, index].sort(),
              })
            }
          >
            {day}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-xs" htmlFor="quiet-start">
          Start
          <Input
            id="quiet-start"
            type="time"
            className="min-h-11 min-w-0"
            value={draft.start_time}
            disabled={busy}
            onChange={(event) => edit({ start_time: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-xs" htmlFor="quiet-end">
          End
          <Input
            id="quiet-end"
            type="time"
            className="min-h-11 min-w-0"
            value={draft.end_time}
            disabled={busy}
            onChange={(event) => edit({ end_time: event.target.value })}
          />
        </label>
      </div>
      <label className="grid gap-1 text-xs" htmlFor="quiet-timezone">
        Time zone
        <Input
          id="quiet-timezone"
          aria-describedby="quiet-zone-help"
          className="min-h-11 min-w-0"
          value={draft.timezone}
          disabled={busy}
          placeholder="America/Mexico_City"
          onChange={(event) => edit({ timezone: event.target.value })}
        />
      </label>
      <p id="quiet-zone-help" className="text-xs text-muted-foreground">
        Starts from this device’s detected time zone and stays fixed when you
        travel. Use an IANA name such as America/Mexico_City.
      </p>
      <p role="status" className="text-xs text-muted-foreground">
        {quiet.active
          ? `Quiet now${quiet.quiet_until ? ` until ${new Date(quiet.quiet_until).toLocaleString()}` : ''}.`
          : quiet.next_change_at
            ? `Next change: ${new Date(quiet.next_change_at).toLocaleString()}.`
            : 'No quiet period is active.'}
      </p>
      {changedElsewhere && (
        <p role="status" className="text-xs text-muted-foreground">
          This schedule changed on another device.
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            onClick={() => {
              setDraft(scheduleFor(quiet));
              setVersion(quiet.version);
              setError('');
            }}
          >
            Load latest schedule
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-xs text-primary">
          Quiet hours saved.
        </p>
      )}
      <Button
        className="min-h-11"
        disabled={
          busy ||
          !draft.timezone.trim() ||
          (draft.enabled &&
            (!draft.weekdays.length || draft.start_time === draft.end_time))
        }
        onClick={() => void save()}
      >
        <Bell size={15} />
        {busy ? 'Saving…' : 'Save quiet hours'}
      </Button>
    </section>
  );
}
