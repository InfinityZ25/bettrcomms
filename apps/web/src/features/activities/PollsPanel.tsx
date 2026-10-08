import { useState } from 'react';
import { BarChart3, Plus } from 'lucide-react';
import type { Room, User } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { pollClosed, type ChannelPoll } from './activityApi';

export type ActivityAction = (
  path: string,
  body?: unknown,
  method?: string,
) => Promise<boolean>;

function newPollOption() {
  return { id: crypto.randomUUID(), value: '' };
}

export function PollsPanel({
  polls,
  room,
  user,
  busy,
  act,
}: {
  polls: ChannelPoll[];
  room: Room;
  user: User;
  busy: boolean;
  act: ActivityAction;
}) {
  const [creating, setCreating] = useState(false);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(() => [
    newPollOption(),
    newPollOption(),
  ]);
  const [closesAt, setClosesAt] = useState('');
  const canPost = room.permissions?.post ?? room.can_post ?? true;
  async function create() {
    const success = await act(
      '/polls',
      {
        question: question.trim(),
        options: options.map((option) => option.value.trim()),
        closes_at: closesAt ? new Date(closesAt).toISOString() : null,
      },
      'POST',
    );
    if (success) {
      setCreating(false);
      setQuestion('');
      setOptions([newPollOption(), newPollOption()]);
      setClosesAt('');
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          One vote per person. Change your mind while a poll is open.
        </p>
        {canPost && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreating(!creating)}
            disabled={busy}
          >
            <Plus size={15} />
            New poll
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
            Question
            <Input
              autoFocus
              required
              maxLength={300}
              className="mt-2"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="What are we playing tonight?"
              disabled={busy}
            />
          </label>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Options</legend>
            {options.map((option, index) => (
              <Input
                key={option.id}
                required
                aria-label={`Poll option ${index + 1}`}
                maxLength={100}
                value={option.value}
                placeholder={`Option ${index + 1}`}
                onChange={(event) => {
                  const value = event.target.value;
                  setOptions((current) =>
                    current.map((entry) =>
                      entry.id === option.id ? { ...entry, value } : entry,
                    ),
                  );
                }}
              />
            ))}
            {options.length < 10 && (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => {
                  const option = newPollOption();
                  setOptions((current) => [...current, option]);
                }}
              >
                Add option
              </Button>
            )}
            {options.length > 2 && (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setOptions((current) => current.slice(0, -1))}
              >
                Remove last option
              </Button>
            )}
          </fieldset>
          <label className="block text-sm">
            Close automatically{' '}
            <span className="text-muted-foreground">(optional)</span>
            <Input
              type="datetime-local"
              className="mt-2"
              value={closesAt}
              onChange={(event) => setClosesAt(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => setCreating(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                !question.trim() ||
                options.some((option) => !option.value.trim())
              }
            >
              Create poll
            </Button>
          </div>
        </form>
      )}
      {!polls.length && (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <BarChart3 size={26} />
          <p className="text-sm">Pick a game, a time or a place together.</p>
        </div>
      )}
      {polls.map((poll) => {
        const total = poll.counts.reduce((sum, count) => sum + count, 0);
        const closed = pollClosed(poll);
        return (
          <article key={poll.id} className="space-y-3 rounded-xl border p-4">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-medium [overflow-wrap:anywhere]">
                {poll.question}
              </h3>
              <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                {closed ? 'Closed' : 'Open'}
              </span>
            </div>
            <div className="space-y-2">
              {poll.options.map((option, index) => (
                <button
                  key={option}
                  type="button"
                  disabled={busy || closed}
                  aria-pressed={poll.vote === index}
                  className={`relative flex min-h-11 w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-default ${poll.vote === index ? 'border-primary' : 'hover:border-primary/50'}`}
                  onClick={() =>
                    void act(`/polls/${poll.id}/vote`, { option: index }, 'PUT')
                  }
                >
                  <span
                    className="absolute inset-y-0 left-0 bg-primary/10"
                    style={{
                      width: `${total ? (poll.counts[index] / total) * 100 : 0}%`,
                    }}
                  />
                  <span className="relative flex w-full items-center justify-between gap-3">
                    <span className="[overflow-wrap:anywhere]">
                      {poll.vote === index ? '✓ ' : ''}
                      {option}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {poll.counts[index]} ·{' '}
                      {total
                        ? Math.round((poll.counts[index] / total) * 100)
                        : 0}
                      %
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {total} {total === 1 ? 'vote' : 'votes'}
                {poll.closes_at && (
                  <> · Ends {new Date(poll.closes_at).toLocaleString()}</>
                )}
              </span>
              <div className="flex gap-1">
                {!closed && poll.vote !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `/polls/${poll.id}/vote`,
                        { option: null },
                        'PUT',
                      )
                    }
                  >
                    Remove vote
                  </Button>
                )}
                {!closed &&
                  canPost &&
                  (poll.author_id === user.id ||
                    room.permissions?.moderate) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void act(`/polls/${poll.id}/close`, {}, 'POST')
                      }
                    >
                      End poll
                    </Button>
                  )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
