import { useState, useSyncExternalStore } from 'react';
import {
  BarChart3,
  CalendarDays,
  Film,
  Sparkles,
  Sticker,
  Volume2,
} from 'lucide-react';
import { api, type Room, type User } from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { createChannelActivityStore } from './activityStore';
import { PollsPanel, type ActivityAction } from './PollsPanel';
import { EventsPanel } from './EventsPanel';
import { MediaAssetsPanel } from './MediaAssetsPanel';
import { WatchTogetherPanel } from './WatchTogetherPanel';

const views = [
  { id: 'polls', label: 'Polls', Icon: BarChart3 },
  { id: 'events', label: 'Events', Icon: CalendarDays },
  { id: 'watch', label: 'Watch together', Icon: Film },
  { id: 'sticker', label: 'Stickers', Icon: Sticker },
  { id: 'sound', label: 'Soundboard', Icon: Volume2 },
] as const;
type View = (typeof views)[number]['id'];

function ActivitiesDialog({
  room,
  user,
  onClose,
}: {
  room: Room;
  user: User;
  onClose: () => void;
}) {
  const [store] = useState(() => createChannelActivityStore(room.id));
  const state = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const [view, setView] = useState<View>('polls');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lifetime = useLifetimeSignal();
  useMountEffect(store.start);
  const act: ActivityAction = async (path, body, method) => {
    if (busy) return false;
    const signal = lifetime();
    setBusy(true);
    setError('');
    try {
      await api(`/rooms/${room.id}${path}`, body, method, signal);
      if (signal.aborted) return false;
      await store.load();
      return !signal.aborted;
    } catch (failure) {
      if (!signal.aborted) {
        setError(
          failure instanceof Error
            ? failure.message
            : 'This action could not finish.',
        );
        await store.load();
      }
      return false;
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Channel activities"
      description={`Make plans and share moments in ${room.name}.`}
      className="flex max-h-[90dvh] flex-col sm:max-w-2xl"
    >
      <div
        className="flex shrink-0 flex-wrap gap-1 border-b pb-3"
        role="group"
        aria-label="Activity views"
      >
        {views.map(({ id, label, Icon }) => (
          <Button
            key={id}
            size="sm"
            variant={view === id ? 'secondary' : 'ghost'}
            aria-pressed={view === id}
            onClick={() => {
              setView(id);
              setError('');
            }}
          >
            <Icon size={14} />
            {label}
          </Button>
        ))}
      </div>
      {(state.error || error) && (
        <p role="alert" className="shrink-0 text-sm text-destructive">
          {error || state.error}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setError('');
              void store.load();
            }}
          >
            Refresh
          </Button>
        </p>
      )}
      <div
        className="min-h-0 overflow-y-auto overscroll-contain pr-1"
        aria-label={`${views.find((item) => item.id === view)?.label} activities`}
        aria-busy={state.loading || busy}
      >
        {state.loading ? (
          <p
            role="status"
            className="py-16 text-center text-sm text-muted-foreground"
          >
            Loading activities…
          </p>
        ) : (
          <>
            {view === 'polls' && (
              <PollsPanel
                polls={state.data.polls}
                room={room}
                user={user}
                busy={busy}
                act={act}
              />
            )}
            {view === 'events' && (
              <EventsPanel
                events={state.data.events}
                room={room}
                user={user}
                busy={busy}
                act={act}
              />
            )}
            {view === 'watch' && (
              <WatchTogetherPanel
                room={room}
                user={user}
                state={state.data.watch}
                receivedAt={state.receivedAt}
                busy={busy}
                act={act}
              />
            )}
            {(view === 'sticker' || view === 'sound') && (
              <MediaAssetsPanel
                key={view}
                kind={view}
                assets={state.data.assets}
                room={room}
                user={user}
                busy={busy}
                act={act}
                refresh={store.load}
              />
            )}
          </>
        )}
      </div>
    </AppDialog>
  );
}

export function ChannelActivities({ room, user }: { room: Room; user: User }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Channel activities"
        className="@max-[480px]/conversation:size-11 @max-[480px]/conversation:px-0"
        onClick={() => setOpen(true)}
      >
        <Sparkles size={15} />
        <span className="hidden sm:inline @max-[480px]/conversation:hidden">
          Activities
        </span>
      </Button>
      {open && (
        <ActivitiesDialog
          key={`${user.id}:${room.id}`}
          room={room}
          user={user}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
