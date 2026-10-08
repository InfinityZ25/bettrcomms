import { useState } from 'react';
import { CalendarDays, Plus } from 'lucide-react';
import type { Room, User } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ScheduledChannelEvent } from './activityApi';
import type { ActivityAction } from './PollsPanel';

export function EventsPanel({
  events,
  room,
  user,
  busy,
  act,
}: {
  events: ScheduledChannelEvent[];
  room: Room;
  user: User;
  busy: boolean;
  act: ActivityAction;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const canPost = room.permissions?.post ?? room.can_post ?? true;
  async function create() {
    const success = await act(
      '/scheduled-events',
      {
        title: title.trim(),
        description: description.trim(),
        starts_at: new Date(startsAt).toISOString(),
      },
      'POST',
    );
    if (success) {
      setCreating(false);
      setTitle('');
      setDescription('');
      setStartsAt('');
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Your local time. Going or Maybe adds a reminder 10 minutes before.
        </p>
        {canPost && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreating(!creating)}
            disabled={busy}
          >
            <Plus size={15} />
            Schedule event
          </Button>
        )}
      </div>
      {creating && (
        <form
          className="space-y-3 rounded-xl border bg-muted/20 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="block text-sm font-medium">
            Title
            <Input
              autoFocus
              required
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy}
              className="mt-2"
              placeholder="Friday game night"
            />
          </label>
          <label className="block text-sm">
            Description
            <textarea
              className="mt-2 min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              maxLength={1000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={busy}
              placeholder="Games, plans and anything people should bring."
            />
          </label>
          <label className="block text-sm font-medium">
            Date and time
            <Input
              type="datetime-local"
              required
              className="mt-2"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim() || !startsAt}>
              Schedule
            </Button>
          </div>
        </form>
      )}
      {!events.length && (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-muted-foreground">
          <CalendarDays size={26} />
          <p className="text-sm">Give the next hangout a date.</p>
        </div>
      )}
      {events.map((event) => (
        <article
          key={event.id}
          className={`rounded-xl border p-4 ${event.cancelled_at ? 'opacity-60' : ''}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-medium [overflow-wrap:anywhere]">
                {event.title}
              </h3>
              <time
                dateTime={event.starts_at}
                className="mt-1 block text-sm text-primary"
              >
                {new Date(event.starts_at).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </time>
            </div>
            {event.cancelled_at && (
              <span className="rounded bg-muted px-2 py-1 text-xs">
                Cancelled
              </span>
            )}
          </div>
          {event.description && (
            <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {event.description}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {!event.cancelled_at &&
              (['going', 'maybe', 'declined'] as const).map((response) => (
                <Button
                  key={response}
                  variant={
                    event.response === response ? 'secondary' : 'outline'
                  }
                  size="sm"
                  aria-pressed={event.response === response}
                  disabled={busy}
                  onClick={() =>
                    void act(
                      `/scheduled-events/${event.id}/rsvp`,
                      { response },
                      'PUT',
                    )
                  }
                >
                  {response === 'going'
                    ? 'Going'
                    : response === 'maybe'
                      ? 'Maybe'
                      : "Can't make it"}
                </Button>
              ))}
            <span className="ml-auto text-xs text-muted-foreground">
              {event.going} going · {event.maybe} maybe
            </span>
          </div>
          {!event.cancelled_at &&
            canPost &&
            (event.author_id === user.id || room.permissions?.moderate) && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                disabled={busy}
                onClick={() =>
                  void act(`/scheduled-events/${event.id}/cancel`, {}, 'POST')
                }
              >
                Cancel event
              </Button>
            )}
        </article>
      ))}
    </div>
  );
}
