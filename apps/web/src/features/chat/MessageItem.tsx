import { useState } from 'react';
import { Pencil, Reply, Smile, Trash2 } from 'lucide-react';
import type { Message } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
const reactions = ['👍', '❤️', '😂', '🎉', '😮', '😢', '👀', '✅'];
export function MessageBody({ message }: { message: Message }) {
  const people = new Map(
    message.mentions?.map((person) => [person.id.toLowerCase(), person.name]),
  );
  let offset = 0;
  return (
    <>
      {message.body.split(/(<@[0-9a-f-]{36}>)/i).map((part) => {
        const key = offset;
        offset += part.length;
        const name = people.get(part.slice(2, -1).toLowerCase());
        return name ? (
          <span
            key={key}
            className="rounded bg-primary/15 px-0.5 font-medium text-primary"
          >
            @{name}
          </span>
        ) : (
          part
        );
      })}
    </>
  );
}

export default function MessageItem({
  message,
  userId,
  highlighted,
  busy,
  onJump,
  onReply,
  onEdit,
  onReact,
  onDelete,
}: {
  message: Message;
  userId: string;
  highlighted: boolean;
  busy: boolean;
  onJump: (id: string) => void;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onReact: (
    message: Message,
    emoji: string,
    remove: boolean,
  ) => Promise<boolean>;
  onDelete: (message: Message) => Promise<boolean>;
}) {
  const [reacting, setReacting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <article
      data-message-id={message.id}
      className={cn(
        'group mb-2 rounded-xl p-2 transition-colors hover:bg-muted/50',
        highlighted && 'bg-primary/10 ring-1 ring-primary/50',
      )}
    >
      <div className="flex gap-2.5">
        <Avatar
          name={message.author.name}
          id={message.author.id}
          src={message.author.avatar_url}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <strong className="text-xs">{message.author.name}</strong>
            <time
              dateTime={message.created_at}
              title={new Date(message.created_at).toLocaleString()}
              className="text-[0.65rem] text-muted-foreground"
            >
              {new Date(message.created_at).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
            {message.edited_at && !message.deleted_at && (
              <span className="text-[0.65rem] text-muted-foreground">
                edited
              </span>
            )}
          </div>
          {message.reply && (
            <button
              className="my-1 block w-full truncate border-l-2 border-primary/50 pl-2 text-left text-xs text-muted-foreground"
              aria-label={`Go to reply from ${message.reply.name}`}
              onClick={() => onJump(message.reply!.id)}
            >
              <Reply size={12} className="mr-1 inline" />
              {message.reply.name}:{' '}
              {message.reply.deleted
                ? 'Message deleted'
                : message.reply.body.replace(/<@[0-9a-f-]{36}>/gi, '@member')}
            </button>
          )}
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
            {message.deleted_at ? (
              <span className="italic text-muted-foreground">
                Message deleted
              </span>
            ) : (
              <MessageBody message={message} />
            )}
          </p>
          {!message.deleted_at && (
            <>
              <div className="mt-1 flex flex-wrap gap-1">
                {message.reactions?.map((reaction) => (
                  <button
                    key={reaction.emoji}
                    disabled={busy}
                    aria-label={`React ${reaction.emoji}, ${reaction.users.length}`}
                    aria-pressed={reaction.users.includes(userId)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-xs',
                      reaction.users.includes(userId)
                        ? 'border-primary bg-primary/15'
                        : 'border-border bg-muted',
                    )}
                    onClick={() =>
                      void onReact(
                        message,
                        reaction.emoji,
                        reaction.users.includes(userId),
                      )
                    }
                  >
                    {reaction.emoji} {reaction.users.length}
                  </button>
                ))}
              </div>
              <div className="mt-1 flex flex-wrap gap-0.5 opacity-70 group-hover:opacity-100 focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Reply to ${message.author.name}`}
                  disabled={busy}
                  onClick={() => {
                    onReply(message);
                  }}
                >
                  <Reply size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add reaction"
                  disabled={busy}
                  onClick={() => setReacting(!reacting)}
                >
                  <Smile size={14} />
                </Button>
                {message.author.id === userId && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Edit message"
                      disabled={busy}
                      onClick={() => onEdit(message)}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete message"
                      disabled={busy}
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </>
                )}
              </div>
              {reacting && (
                <div
                  className="my-1 flex flex-wrap gap-1 rounded-xl border bg-card p-1"
                  aria-label="Choose reaction"
                >
                  {reactions.map((emoji) => (
                    <Button
                      key={emoji}
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Add ${emoji} reaction`}
                      disabled={busy}
                      onClick={() => {
                        void onReact(message, emoji, false);
                        setReacting(false);
                      }}
                    >
                      {emoji}
                    </Button>
                  ))}
                </div>
              )}
              {confirmDelete && (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 p-2 text-xs"
                  role="alert"
                >
                  <span>Delete this message?</span>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() =>
                      void onDelete(message).then((deleted) => {
                        if (deleted) setConfirmDelete(false);
                      })
                    }
                  >
                    Confirm delete
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
