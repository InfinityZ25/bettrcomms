import { useState } from 'react';
import { Flag, Pencil, Reply, ShieldX, Smile, Trash2 } from 'lucide-react';
import { api, type Message } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import MessageAttachmentPreview from './MessageAttachmentPreview';
const reactions = ['👍', '❤️', '😂', '🎉', '😮', '😢', '👀', '✅'];
const linkPattern = /https?:\/\/[^\s<>"']+/gi;
function linkedText(text: string, offset: number) {
  const result: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(linkPattern)) {
    const start = match.index;
    const raw = match[0];
    let url = raw.replace(/[.,!?;:]+$/, '');
    const brackets: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    while (url.length && brackets[url.at(-1)!]) {
      const closing = url.at(-1)!;
      if (url.split(closing).length <= url.split(brackets[closing]).length) break;
      url = url.slice(0, -1);
    }
    url = url.replace(/[.,!?;:]+$/, '');
    if (start > last) result.push(text.slice(last, start));
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Invalid URL');
      result.push(<a key={offset + start} href={parsed.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-primary underline underline-offset-2 hover:no-underline">{url}</a>);
    } catch {
      result.push(url);
    }
    result.push(raw.slice(url.length));
    last = start + raw.length;
  }
  result.push(text.slice(last));
  return result;
}
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
          linkedText(part, key)
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
  onReport,
  onModerate,
  canModerate,
  onError,
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
  onReport: (message: Message, reason: string) => Promise<boolean>;
  onModerate: (message: Message, reason: string) => Promise<boolean>;
  canModerate: boolean;
  onError: (message: string) => void;
}) {
  const [reacting, setReacting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [moderating, setModerating] = useState(false);
  const [reason, setReason] = useState('');
  const [reported, setReported] = useState(false);
  const openAttachment = async (id: string) => {
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const result = await api<{ url: string }>(`/rooms/${message.room_id}/attachments/${id}?link=1`);
      if (tab) tab.location.href = result.url;
      else window.location.href = result.url;
    } catch (error) {
      tab?.close();
      onError(error instanceof Error ? error.message : 'Could not open attachment');
    }
  };
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
          {!message.deleted_at && !!message.attachments?.length && (
            <div className="mt-2 grid max-w-lg gap-2" aria-label="Attachments">
              {message.attachments.map((attachment) => (
                <MessageAttachmentPreview key={attachment.id} attachment={attachment} roomId={message.room_id} onError={onError} onDownload={() => void openAttachment(attachment.id)} />
              ))}
            </div>
          )}
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
                {message.author.id !== userId && (
                  <Button variant="ghost" size="icon-sm" aria-label="Report message" disabled={busy} onClick={() => { setReporting(true); setModerating(false); }}><Flag size={14} /></Button>
                )}
                {canModerate && message.author.id !== userId && (
                  <Button variant="ghost" size="icon-sm" aria-label="Remove message as moderator" disabled={busy} onClick={() => { setModerating(true); setReporting(false); }}><ShieldX size={14} /></Button>
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
              {(reporting || moderating) && (
                <form className="mt-2 flex flex-col gap-2 rounded-lg border p-2 text-xs" onSubmit={(event) => {
                  event.preventDefault();
                  const action = reporting ? onReport : onModerate;
                  void (async () => {
                    const done = await action(message, reason.trim());
                    if (done) {
                      setReporting(false);
                      setModerating(false);
                      setReported(reporting);
                      setReason('');
                    }
                  })();
                }}>
                  <label htmlFor={`reason-${message.id}`}>{reporting ? 'Why are you reporting this message?' : 'Reason for removing this message'}</label>
                  <input id={`reason-${message.id}`} className="rounded border bg-background px-2 py-1" value={reason} maxLength={500} minLength={3} required onChange={(event) => setReason(event.target.value)} />
                  <div className="flex gap-2"><Button size="sm" type="submit" disabled={busy || reason.trim().length < 3}>{reporting ? 'Send report' : 'Remove message'}</Button><Button size="sm" variant="ghost" type="button" onClick={() => { setReporting(false); setModerating(false); }}>Cancel</Button></div>
                </form>
              )}
              {reported && <span className="text-xs text-muted-foreground">Report sent</span>}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
