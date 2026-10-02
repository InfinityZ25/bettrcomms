import { lazy, Suspense, useState } from 'react';
import { Flag, MoreHorizontal, Pencil, Reply, ShieldX, Smile, Trash2, Pin, PinOff, MessagesSquare } from 'lucide-react';
import { api, type Message } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import MessageAttachmentPreview from './MessageAttachmentPreview';
import PlainMessage from './PlainMessage';
import EmojiDialog from './EmojiDialog';
import { formatMessagePreview, needsMessageFormatting } from './messageFormatting';

const FormattedMessage = lazy(() => import('./FormattedMessage'));
export function MessageBody({ message }: { message: Message }) {
  if (!needsMessageFormatting(message.body)) return <PlainMessage message={message} />;
  return <Suspense fallback={<span className="text-muted-foreground">Loading formatted message…</span>}><FormattedMessage message={message} /></Suspense>;
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
  onThread,
  onPin,
  canPin = false,
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
  onThread?: (message: Message) => void;
  onPin?: (message: Message, remove: boolean) => Promise<boolean>;
  canPin?: boolean;
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
      tabIndex={0}
      className={cn(
        'message-item group relative mb-2 rounded-xl p-2 phone:mb-1 phone:py-3 outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors hover:bg-muted/50 [@media(hover:none)]:focus-within:bg-muted/50',
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
          <div className="flex flex-wrap items-baseline gap-2 phone:pr-11">
            <strong className="min-w-0 truncate text-xs phone:text-sm">{message.author.name}</strong>
            <time
              dateTime={message.created_at}
              title={new Date(message.created_at).toLocaleString()}
              className="text-[0.65rem] text-muted-foreground phone:text-xs"
            >
              {new Date(message.created_at).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
            {message.edited_at && !message.deleted_at && (
              <span className="text-[0.65rem] text-muted-foreground phone:text-xs">
                edited
              </span>
            )}
          </div>
          {message.pinned_at && <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground"><Pin size={12} /> Pinned</span>}
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
                : formatMessagePreview(message.reply.body)}
            </button>
          )}
          <div className="mt-1 text-sm leading-6 phone:text-base [overflow-wrap:anywhere] [&>p+p]:mt-2">
            {message.deleted_at ? (
              <span className="italic text-muted-foreground">
                Message deleted
              </span>
            ) : (
              <MessageBody message={message} />
            )}
          </div>
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
                      'rounded-full border px-2 py-0.5 text-xs phone:min-h-11 phone:px-3',
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
              <div className="phone:hidden"><div className="mt-1 flex flex-wrap gap-0.5 opacity-70 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:hidden [@media(hover:none)]:group-focus-within:flex [@media(hover:none)]:opacity-100">
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
                {canPin && onPin && <Button variant="ghost" size="icon-sm" aria-label={message.pinned_at ? 'Unpin message' : 'Pin message'} disabled={busy} onClick={() => void onPin(message, Boolean(message.pinned_at))}>{message.pinned_at ? <PinOff size={14} /> : <Pin size={14} />}</Button>}
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
              </div>
              <div className="absolute top-1 right-0 hidden phone:block">
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-11 text-muted-foreground" aria-label={`Message options for ${message.author.name}`} disabled={busy} />}><MoreHorizontal size={18} /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-52 [&_[data-slot=dropdown-menu-item]]:min-h-11">
                    <DropdownMenuItem onClick={() => onReply(message)}><Reply /> Reply</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setReacting(true)}><Smile /> Add reaction</DropdownMenuItem>
                    {canPin && onPin && <DropdownMenuItem onClick={() => void onPin(message, Boolean(message.pinned_at))}><Pin /> {message.pinned_at ? 'Unpin message' : 'Pin message'}</DropdownMenuItem>}
                    {message.author.id === userId ? <>
                      <DropdownMenuItem onClick={() => onEdit(message)}><Pencil /> Edit message</DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete message</DropdownMenuItem>
                    </> : <DropdownMenuItem onClick={() => { setReporting(true); setModerating(false); }}><Flag /> Report message</DropdownMenuItem>}
                    {canModerate && message.author.id !== userId && <DropdownMenuItem variant="destructive" onClick={() => { setModerating(true); setReporting(false); }}><ShieldX /> Remove message as moderator</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {reacting && <EmojiDialog onClose={() => setReacting(false)} onSelect={(emoji) => {
                void onReact(message, emoji, message.reactions?.some((reaction) => reaction.emoji === emoji && reaction.users.includes(userId)) ?? false).then((done) => { if (done) setReacting(false); });
              }} />}
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
              {reported && (
                <span className="text-xs text-muted-foreground">
                  Report sent
                </span>
              )}
            </>
          )}
          {onThread && !message.thread_root_id && (!message.deleted_at || (message.thread_reply_count ?? 0) > 0) && <Button variant="ghost" size="sm" aria-label="Open thread" className="mt-1 gap-1 text-xs" disabled={busy} onClick={() => onThread(message)}><MessagesSquare size={14} />{message.thread_reply_count ? `${message.thread_reply_count} replies` : 'Start thread'}</Button>}
        </div>
      </div>
    </article>
  );
}
