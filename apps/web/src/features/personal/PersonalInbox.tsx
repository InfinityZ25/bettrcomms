import { useState, useSyncExternalStore } from 'react';
import {
  Bell,
  Bookmark,
  CalendarDays,
  Check,
  Clock,
  Inbox,
  RefreshCw,
  X,
} from 'lucide-react';
import type { User } from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import {
  api,
  subscribePersonalEvents,
  type MessageReminder,
  type SavedItem,
} from './api';
import { createPersonalList } from './listStore';
import {
  consumeInboxRequest,
  openPersonalInbox,
  type InboxTab,
} from './inboxEvents';
import {
  cancelMessageReminder,
  completeMessageReminder,
  personalSnapshot,
  subscribePersonal,
  toggleSaved,
} from './personalStore';
import ReminderPicker from './ReminderPicker';
import { formatMessagePreview } from '@/features/chat/messageFormatting';
import MessageAttachmentPreview from '@/features/chat/MessageAttachmentPreview';
import { downloadMessageAttachment } from '@/features/chat/attachmentFiles';
import { subscribeActivityEvents } from '@/features/activities/activityEvents';
import type { ChannelEventReminder } from '@/features/activities/activityApi';

type Navigation = {
  onOpenRoom?: (id: string) => void;
  onOpenMessage?: (roomId: string, messageId: string) => void;
};
export function PersonalInboxButton({
  user,
  onOpenRoom,
  onOpenMessage,
}: { user: User } & Navigation) {
  const personal = useSyncExternalStore(subscribePersonal, personalSnapshot);
  const [tab, setTab] = useState<InboxTab>('reminders');
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ChannelEventReminder[]>([]);
  const lifetime = useLifetimeSignal();
  async function loadEvents() {
    const signal = lifetime();
    try {
      const result = await api<{ reminders: ChannelEventReminder[] }>(
        '/me/event-reminders',
        undefined,
        undefined,
        signal,
      );
      if (!signal.aborted) setEvents(result.reminders);
    } catch {
      /* Message reminders and saved items remain accessible independently. */
    }
  }
  useMountEffect(() => {
    const show = (event: Event) => {
      const value = (event as CustomEvent<InboxTab>).detail;
      consumeInboxRequest();
      setTab(value === 'saved' ? 'saved' : 'reminders');
      setOpen(true);
      void loadEvents();
    };
    window.addEventListener('bc-personal-inbox', show);
    const requested = consumeInboxRequest();
    const params = new URLSearchParams(window.location.search);
    if (requested || params.get('open_inbox') === 'reminders') {
      setTab(requested ?? 'reminders');
      setOpen(true);
      if (params.get('open_inbox') === 'reminders') {
        const url = new URL(window.location.href);
        url.searchParams.delete('open_inbox');
        window.history.replaceState(null, '', url);
      }
    }
    const off = subscribeActivityEvents((event) => {
      if (
        event.type === 'channel.activity' &&
        event.kind === 'scheduled-events'
      )
        void loadEvents();
    });
    const offPersonal = subscribePersonalEvents((type) => {
      if (type === 'personal.reminders.changed') void loadEvents();
    });
    const timer = setInterval(() => {
      void loadEvents();
    }, 60000);
    void loadEvents();
    return () => {
      window.removeEventListener('bc-personal-inbox', show);
      off();
      offPersonal();
      clearInterval(timer);
    };
  });
  const due =
    personal.userId === user.id
      ? personal.reminders.filter((item) => item.state === 'due').length
      : 0;
  const count = due + events.length;
  return (
    <>
      <Button
        size="icon-sm"
        variant={count ? 'secondary' : 'ghost'}
        aria-label={`Personal inbox${count ? `, ${count} reminders due` : ''}`}
        className="relative shrink-0 max-[820px]:size-11"
        onClick={() => openPersonalInbox()}
      >
        <Bell size={16} />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.6875rem] font-semibold tabular-nums text-primary-foreground">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Button>
      {open && (
        <AppDialog
          open
          onOpenChange={setOpen}
          title="Personal inbox"
          description="Your saved items and reminders. Only you can see them."
          className="flex max-h-[85dvh] flex-col sm:max-w-2xl"
        >
          <div
            className="inline-flex shrink-0 gap-1 self-start rounded-full bg-muted/60 p-1"
            role="group"
            aria-label="Personal inbox views"
          >
            <Button
              className="min-h-11 rounded-full text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-[var(--shadow-soft)] aria-pressed:hover:bg-background"
              variant={tab === 'reminders' ? 'secondary' : 'ghost'}
              aria-pressed={tab === 'reminders'}
              onClick={() => setTab('reminders')}
            >
              <Bell size={16} />
              Reminders
            </Button>
            <Button
              className="min-h-11 rounded-full text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-[var(--shadow-soft)] aria-pressed:hover:bg-background"
              variant={tab === 'saved' ? 'secondary' : 'ghost'}
              aria-pressed={tab === 'saved'}
              onClick={() => setTab('saved')}
            >
              <Bookmark size={16} />
              Saved
            </Button>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            {tab === 'saved' ? (
              <SavedItems
                key={user.id}
                onOpenMessage={(room, message) => {
                  onOpenMessage?.(room, message);
                  setOpen(false);
                }}
              />
            ) : (
              <Reminders
                key={user.id}
                events={events}
                reloadEvents={loadEvents}
                onOpenRoom={(id) => {
                  onOpenRoom?.(id);
                  setOpen(false);
                }}
                onOpenMessage={(room, message) => {
                  onOpenMessage?.(room, message);
                  setOpen(false);
                }}
              />
            )}
          </div>
        </AppDialog>
      )}
    </>
  );
}

function SavedItems({ onOpenMessage }: Navigation) {
  const [kind, setKind] = useState('all');
  return (
    <div className="space-y-3">
      <div
        className="inline-flex max-w-full flex-wrap gap-1 rounded-full bg-muted/60 p-1"
        role="group"
        aria-label="Saved item filters"
      >
        {[
          ['all', 'All'],
          ['message', 'Messages'],
          ['link', 'Links'],
          ['file', 'Files'],
        ].map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            className="min-h-11 rounded-full text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-[var(--shadow-soft)] aria-pressed:hover:bg-background"
            variant={kind === value ? 'secondary' : 'ghost'}
            aria-pressed={kind === value}
            onClick={() => setKind(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      <SavedPage key={kind} kind={kind} onOpenMessage={onOpenMessage} />
    </div>
  );
}
function SavedPage({ kind, onOpenMessage }: { kind: string } & Navigation) {
  const [store] = useState(() =>
    createPersonalList<SavedItem>(
      `/me/saved-items?kind=${kind}&limit=50`,
      'items',
    ),
  );
  const page = useSyncExternalStore(store.subscribe, store.snapshot);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const lifetime = useLifetimeSignal();
  useMountEffect(store.start);
  async function remove(item: SavedItem) {
    if (busy) return;
    const signal = lifetime();
    setBusy(item.id);
    setError('');
    const source =
      item.kind === 'file' ? item.attachment?.id : item.message?.id;
    try {
      if (source) await toggleSaved(item.kind, source);
      if (!signal.aborted) await store.load();
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not remove saved item.',
        );
    } finally {
      if (!signal.aborted) setBusy('');
    }
  }
  return (
    <>
      <ListFeedback
        loading={page.loading}
        error={error || page.error}
        empty={!page.items.length}
        label="Nothing saved here yet. Save a message or file from its conversation."
        retry={() => void store.load()}
      />
      <ul className="space-y-3" aria-label="Saved items">
        {page.items.map((item) => (
          <li key={item.id} className="rounded-2xl bc-card p-3 transition hover:border-foreground/15">
            <p className="text-xs text-muted-foreground">
              {item.room_name}
              {item.message ? ` · ${item.message.author.name}` : ''} ·{' '}
              {new Date(item.created_at).toLocaleDateString()}
            </p>
            {item.message && (
              <p className="my-2 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                {formatMessagePreview(item.message.body) ||
                  'Message with attachments'}
              </p>
            )}
            {item.attachment && (
              <MessageAttachmentPreview
                attachment={item.attachment}
                roomId={item.room_id}
                onError={setError}
                onDownload={() =>
                  void downloadMessageAttachment(
                    item.room_id,
                    item.attachment!.id,
                    item.attachment!.filename,
                    { signal: lifetime(), onError: setError },
                  )
                }
              />
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                disabled={!item.message}
                onClick={() => {
                  if (item.message)
                    onOpenMessage?.(item.room_id, item.message.id);
                }}
              >
                Open original
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11"
                disabled={Boolean(busy)}
                onClick={() => void remove(item)}
              >
                <X size={14} />
                Remove saved
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {page.cursor && (
        <Button
          variant="outline"
          className="mt-3 min-h-11 w-full"
          disabled={page.loading}
          onClick={() => void store.load(true)}
        >
          More saved items
        </Button>
      )}
    </>
  );
}
function Reminders({
  events,
  reloadEvents,
  onOpenRoom,
  onOpenMessage,
}: {
  events: ChannelEventReminder[];
  reloadEvents: () => Promise<void>;
} & Navigation) {
  const [filter, setFilter] = useState('active');
  return (
    <div className="space-y-3">
      <div
        className="inline-flex max-w-full flex-wrap gap-1 rounded-full bg-muted/60 p-1"
        role="group"
        aria-label="Reminder filters"
      >
        {[
          ['active', 'All'],
          ['due', 'Due'],
          ['pending', 'Scheduled'],
        ].map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            className="min-h-11 rounded-full text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-[var(--shadow-soft)] aria-pressed:hover:bg-background"
            variant={filter === value ? 'secondary' : 'ghost'}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {filter !== 'pending' && events.length > 0 && (
        <EventReminders
          events={events}
          reload={reloadEvents}
          onOpenRoom={onOpenRoom}
        />
      )}
      <ReminderPage
        key={filter}
        filter={filter}
        onOpenMessage={onOpenMessage}
      />
    </div>
  );
}
function ReminderPage({
  filter,
  onOpenMessage,
}: { filter: string } & Navigation) {
  const [store] = useState(() =>
    createPersonalList<MessageReminder>(
      `/me/message-reminders?state=${filter}&limit=50`,
      'reminders',
    ),
  );
  const page = useSyncExternalStore(store.subscribe, store.snapshot);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [snooze, setSnooze] = useState<MessageReminder | null>(null);
  const lifetime = useLifetimeSignal();
  useMountEffect(store.start);
  async function complete(item: MessageReminder, cancel = false) {
    if (busy) return;
    const signal = lifetime();
    setBusy(item.id);
    setError('');
    try {
      if (cancel) await cancelMessageReminder(item.room_id, item.message.id);
      else await completeMessageReminder(item.id);
      if (!signal.aborted) await store.load();
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not update reminder.',
        );
    } finally {
      if (!signal.aborted) setBusy('');
    }
  }
  return (
    <>
      <ListFeedback
        loading={page.loading}
        error={error || page.error}
        empty={!page.items.length}
        label="No message reminders here. Use Remind me to reply on a message."
        retry={() => void store.load()}
      />
      <ul className="space-y-3" aria-label="Message reminders">
        {page.items.map((item) => (
          <li
            key={item.id}
            className={`rounded-2xl border p-3 transition-colors hover:bg-accent/60 ${item.state === 'due' ? 'border-primary/30 bg-primary/5' : 'bg-muted/10'}`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Clock size={13} />
              <span>
                {item.state === 'due' ? 'Due' : 'Scheduled'} ·{' '}
                {new Date(item.due_at).toLocaleString()}
              </span>
              <span>
                {item.room_name} · {item.message.author.name}
              </span>
            </div>
            <p className="my-2 line-clamp-3 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
              {formatMessagePreview(item.message.body) ||
                'Message with attachments'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                className="min-h-11"
                onClick={() => onOpenMessage?.(item.room_id, item.message.id)}
              >
                Open message
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11"
                disabled={Boolean(busy)}
                onClick={() => setSnooze(item)}
              >
                Snooze
              </Button>
              <Button
                size="sm"
                className="min-h-11"
                disabled={Boolean(busy)}
                onClick={() => void complete(item)}
              >
                <Check size={14} />
                Done
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-11"
                aria-label="Cancel reminder"
                disabled={Boolean(busy)}
                onClick={() => void complete(item, true)}
              >
                <X size={14} />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {page.cursor && (
        <Button
          variant="outline"
          className="mt-3 min-h-11 w-full"
          disabled={page.loading}
          onClick={() => void store.load(true)}
        >
          More reminders
        </Button>
      )}
      {snooze && (
        <ReminderPicker
          roomId={snooze.room_id}
          messageId={snooze.message.id}
          existing={snooze.due_at}
          onClose={() => {
            setSnooze(null);
            void store.load();
          }}
        />
      )}
    </>
  );
}
function EventReminders({
  events,
  reload,
  onOpenRoom,
}: {
  events: ChannelEventReminder[];
  reload: () => Promise<void>;
} & Navigation) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const lifetime = useLifetimeSignal();
  async function dismiss(id: string) {
    const signal = lifetime();
    setBusy(id);
    setError('');
    try {
      await api(`/me/event-reminders/${id}`, undefined, 'DELETE', signal);
      if (!signal.aborted) await reload();
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not dismiss event reminder.',
        );
    } finally {
      if (!signal.aborted) setBusy('');
    }
  }
  return (
    <section className="space-y-2" aria-label="Event reminders">
      <h3 className="bc-kicker">
        Events starting soon
      </h3>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {events.map((item) => (
        <div
          key={item.id}
          className="rounded-2xl border border-primary/25 bg-primary/5 p-3"
        >
          <h4 className="font-heading flex items-center gap-2 text-sm font-bold">
            <CalendarDays size={15} className="size-8 shrink-0 rounded-xl bg-primary/15 p-1.5 text-primary" />
            {item.title}
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.room_name} · {new Date(item.starts_at).toLocaleString()}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="min-h-11"
              onClick={() => onOpenRoom?.(item.room_id)}
            >
              Open channel
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11"
              disabled={Boolean(busy)}
              onClick={() => void dismiss(item.id)}
            >
              <Check size={14} />
              Dismiss
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
function ListFeedback({
  loading,
  error,
  empty,
  label,
  retry,
}: {
  loading: boolean;
  error: string;
  empty: boolean;
  label: string;
  retry: () => void;
}) {
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
        <Button variant="ghost" size="sm" className="min-h-11" onClick={retry}>
          <RefreshCw size={14} />
          Retry
        </Button>
      </p>
    );
  if (empty)
    return (
      <div className="animate-bc-rise flex min-h-36 flex-col items-center justify-center gap-3 p-4 text-center text-sm text-muted-foreground">
        <Inbox size={25} className="size-12 rounded-2xl bg-muted p-3" />
        <p role="status">{loading ? 'Loading your inbox…' : label}</p>
      </div>
    );
  return loading ? (
    <p role="status" className="text-xs text-muted-foreground">
      Updating…
    </p>
  ) : null;
}
