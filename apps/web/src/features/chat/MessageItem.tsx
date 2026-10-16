import { lazy, Suspense, useState } from 'react';
import {
  Flag,
  MoreHorizontal,
  Pencil,
  Reply,
  ShieldX,
  Smile,
  Trash2,
  Pin,
  PinOff,
  MessagesSquare,
  Film,
} from 'lucide-react';
import type { Message } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import MessageAttachmentPreview from './MessageAttachmentPreview';
import PlainMessage from './PlainMessage';
import EmojiDialog from './EmojiDialog';
import {
  formatMessagePreview,
  needsMessageFormatting,
} from './messageFormatting';
import { openUserProfile } from '@/features/settings/ProfileDialog';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { downloadMessageAttachment } from './attachmentFiles';
import { MessageHistory } from '@/features/activities/MessageHistory';
import { MessageReminderDialog, PersonalMessageActions, SaveFileButton } from '@/features/personal/MessageActions';
import { youtubeWatchURL } from '@/features/activities/youtubeURL';
// Presentational only: an author's name is tinted with the hue of their avatar.
import { hueFor } from '@/features/settings/blobatarIdentity';

const FormattedMessage = lazy(() => import('./FormattedMessage'));
export function MessageBody({ message }: { message: Message }) {
  if (!needsMessageFormatting(message.body))
    return <PlainMessage message={message} />;
  return (
    <Suspense
      fallback={
        <span className="text-muted-foreground">
          Loading formatted message…
        </span>
      }
    >
      <FormattedMessage message={message} />
    </Suspense>
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
  onThread,
  onPin,
  canPin = false,
  onWatchLink,
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
  onWatchLink?: (url: string) => void;
}) {
  const [reacting, setReacting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [moderating, setModerating] = useState(false);
  const [reason, setReason] = useState('');
  const [reported, setReported] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const lifetime = useLifetimeSignal();
  const watchURL = onWatchLink && !message.deleted_at ? youtubeWatchURL(message.body) : undefined;
  const openAttachment = (id: string) =>
    downloadMessageAttachment(
      message.room_id,
      id,
      message.attachments?.find((attachment) => attachment.id === id)
        ?.filename ?? '',
      { signal: lifetime(), onError },
    );
  return (
    <article
      data-message-id={message.id}
      tabIndex={0}
      className={cn(
        'message-item group relative mb-0.5 rounded-xl px-3 py-2 outline-none transition-colors duration-150 hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-ring/50 [@media(hover:none)]:focus-within:bg-accent/45 phone:mb-1 phone:px-2 phone:py-3',
        // A message that mentions the reader: amber wash and an amber bar.
        !!message.mentions?.some((person) => person.id === userId) &&
          message.author.id !== userId &&
          'bg-amber/8 before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-amber hover:bg-amber/12',
        highlighted && 'bg-primary/10 ring-1 ring-primary/50',
      )}
    >
      <div className="flex gap-3">
        <button
          type="button"
          className="mt-0.5 shrink-0 self-start rounded-xl transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
          aria-label={`View ${message.author.name}'s profile`}
          onClick={() => openUserProfile(message.author.id)}
        >
          <Avatar
            name={message.author.name}
            id={message.author.id}
            src={message.author.avatar_url}
            className="size-10"
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 phone:pr-11">
            <button
              type="button"
              aria-label={`Open profile for ${message.author.name}`}
              // Light and dark lightness/chroma keep every hue at 5:1 or better
              // on the canvas, hover, mention and highlight surfaces.
              className="relative z-20 min-w-0 truncate text-[0.9375rem] leading-snug font-semibold text-[oklch(0.47_0.12_var(--name-hue))] underline-offset-2 hover:underline phone:z-auto dark:text-[oklch(0.8_0.12_var(--name-hue))]"
              style={{ '--name-hue': hueFor(message.author.id) } as React.CSSProperties}
              onClick={() => openUserProfile(message.author.id)}
            >
              {message.author.name}
            </button>
            <time
              dateTime={message.created_at}
              title={new Date(message.created_at).toLocaleString()}
              className="text-xs text-muted-foreground tabular-nums"
            >
              {new Date(message.created_at).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
            {message.edited_at && !message.deleted_at && (
              <button type="button" aria-label="View edit history" onClick={() => setHistoryOpen(true)} className="relative z-20 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline phone:z-auto">
                edited
              </button>
            )}
          </div>
          {message.pinned_at && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber/12 px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground [&>svg]:text-amber">
              <Pin size={12} /> Pinned
            </span>
          )}
          {message.reply && (
            <button
              className="my-1 block w-full truncate border-l-2 border-primary/40 pl-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
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
          <div
            data-message-body
            className="mt-0.5 text-[0.9375rem] leading-relaxed text-foreground phone:text-base [overflow-wrap:anywhere] [&>p+p]:mt-2"
          >
            {message.deleted_at ? (
              <span className="italic text-muted-foreground">
                Message deleted
              </span>
            ) : (
              <MessageBody message={message} />
            )}
          </div>
          {!message.deleted_at && !!message.attachments?.length && (
            <div className="mt-2 grid max-w-lg gap-2.5" aria-label="Attachments">
              {message.attachments.map((attachment) => (
                <div key={attachment.id} className="grid gap-1">
                  <MessageAttachmentPreview attachment={attachment} roomId={message.room_id} onError={onError} onDownload={() => void openAttachment(attachment.id)} />
                  <SaveFileButton attachmentId={attachment.id} filename={attachment.filename} onError={onError} />
                </div>
              ))}
            </div>
          )}
          {watchURL && (
            <Button size="sm" variant="outline" className="mt-2 min-h-11 rounded-full px-4 [&_svg]:text-primary" onClick={() => onWatchLink?.(watchURL)}>
              <Film size={15} /> Watch together
            </Button>
          )}
          {!message.deleted_at && (
            <>
              <div className="mt-1.5 flex flex-wrap gap-1.5 empty:hidden">
                {message.reactions?.map((reaction) => (
                  <button
                    key={reaction.emoji}
                    disabled={busy}
                    aria-label={`React ${reaction.emoji}, ${reaction.users.length}`}
                    aria-pressed={reaction.users.includes(userId)}
                    className={cn(
                      'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-sm leading-none font-medium tabular-nums transition-[background-color,border-color,translate] duration-150 enabled:hover:-translate-y-px enabled:active:translate-y-0 phone:min-h-11 phone:px-3',
                      // Text on a lime tint: pure lime in dark, a deeper ink in
                      // light, where lime text on its own tint falls under 4.5:1.
                      reaction.users.includes(userId)
                        ? 'border-primary/40 bg-primary/12 text-[color-mix(in_oklab,var(--primary)_75%,var(--foreground))] hover:bg-primary/18 dark:text-primary'
                        : 'border-border bg-muted/60 text-foreground hover:border-foreground/20 hover:bg-muted',
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
              <div className="phone:hidden">
                <div
                  // A floating glass toolbar on the row's top-right edge,
                  // revealed by opacity only: it stays hit-testable, so a
                  // pointer that moves to a button reveals it on the way. It
                  // straddles the row's top padding, so it covers the author
                  // line's empty end and never the text below it; the button
                  // centres stay inside the row. The author line's buttons
                  // stack above it where a narrow log brings the two together,
                  // and in the narrowest logs (the call's side column) it stays
                  // in the flow. A docked "Start thread" gets room at its end.
                  className="absolute -top-2 right-2 z-10 flex flex-wrap items-center gap-0.5 rounded-xl border border-border bc-glass p-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 @max-[24rem]/message-log:static @max-[24rem]/message-log:mt-1.5 @max-[24rem]/message-log:w-fit [@media(hover:hover)]:@min-[34rem]/message-log:group-has-[.message-thread-start]:pr-[6.875rem] [@media(hover:none)]:hidden [@media(hover:none)]:group-focus-within:flex [@media(hover:none)]:opacity-100">
                  <PersonalMessageActions message={message} userId={userId} onError={onError} />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-lg text-muted-foreground hover:text-foreground"
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
                    className="rounded-lg text-muted-foreground hover:text-foreground"
                    aria-label="Add reaction"
                    disabled={busy}
                    onClick={() => setReacting(!reacting)}
                  >
                    <Smile size={14} />
                  </Button>
                  {canPin && onPin && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-lg text-muted-foreground hover:text-foreground"
                      aria-label={
                        message.pinned_at ? 'Unpin message' : 'Pin message'
                      }
                      disabled={busy}
                      onClick={() =>
                        void onPin(message, Boolean(message.pinned_at))
                      }
                    >
                      {message.pinned_at ? (
                        <PinOff size={14} />
                      ) : (
                        <Pin size={14} />
                      )}
                    </Button>
                  )}
                  {message.author.id === userId && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="rounded-lg text-muted-foreground hover:text-foreground"
                        aria-label="Edit message"
                        disabled={busy}
                        onClick={() => onEdit(message)}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="rounded-lg text-muted-foreground hover:bg-destructive/12 hover:text-destructive dark:hover:bg-destructive/15"
                        aria-label="Delete message"
                        disabled={busy}
                        onClick={() => setConfirmDelete(true)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </>
                  )}
                  {message.author.id !== userId && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-lg text-muted-foreground hover:text-foreground"
                      aria-label="Report message"
                      disabled={busy}
                      onClick={() => {
                        setReporting(true);
                        setModerating(false);
                      }}
                    >
                      <Flag size={14} />
                    </Button>
                  )}
                  {canModerate && message.author.id !== userId && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-lg text-muted-foreground hover:bg-destructive/12 hover:text-destructive dark:hover:bg-destructive/15"
                      aria-label="Remove message as moderator"
                      disabled={busy}
                      onClick={() => {
                        setModerating(true);
                        setReporting(false);
                      }}
                    >
                      <ShieldX size={14} />
                    </Button>
                  )}
                </div>
              </div>
              <div className="absolute top-1 right-0 hidden phone:block">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11 rounded-xl text-muted-foreground"
                        aria-label={`Message options for ${message.author.name}`}
                        disabled={busy}
                      />
                    }
                  >
                    <MoreHorizontal size={18} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="min-w-52 [&_[data-slot=dropdown-menu-item]]:min-h-11"
                  >
                    <PersonalMessageActions message={message} userId={userId} menu onError={onError} onRemind={() => setReminderOpen(true)} />
                    <DropdownMenuItem onClick={() => onReply(message)}>
                      <Reply /> Reply
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setReacting(true)}>
                      <Smile /> Add reaction
                    </DropdownMenuItem>
                    {canPin && onPin && (
                      <DropdownMenuItem
                        onClick={() =>
                          void onPin(message, Boolean(message.pinned_at))
                        }
                      >
                        <Pin />{' '}
                        {message.pinned_at ? 'Unpin message' : 'Pin message'}
                      </DropdownMenuItem>
                    )}
                    {message.author.id === userId ? (
                      <>
                        <DropdownMenuItem onClick={() => onEdit(message)}>
                          <Pencil /> Edit message
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setConfirmDelete(true)}
                        >
                          <Trash2 /> Delete message
                        </DropdownMenuItem>
                      </>
                    ) : (
                      <DropdownMenuItem
                        onClick={() => {
                          setReporting(true);
                          setModerating(false);
                        }}
                      >
                        <Flag /> Report message
                      </DropdownMenuItem>
                    )}
                    {canModerate && message.author.id !== userId && (
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          setModerating(true);
                          setReporting(false);
                        }}
                      >
                        <ShieldX /> Remove message as moderator
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {reacting && (
                <EmojiDialog
                  userId={userId}
                  onClose={() => setReacting(false)}
                  onSelect={(emoji) => {
                    void onReact(
                      message,
                      emoji,
                      message.reactions?.some(
                        (reaction) =>
                          reaction.emoji === emoji &&
                          reaction.users.includes(userId),
                      ) ?? false,
                    ).then((done) => {
                      if (done) setReacting(false);
                    });
                  }}
                />
              )}
              {confirmDelete && (
                <div
                  className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/8 py-2 pr-2 pl-3 text-sm"
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
                <form
                  className="mt-2 flex flex-col gap-2 rounded-xl border border-border bg-card/70 p-3 text-sm"
                  onSubmit={(event) => {
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
                  }}
                >
                  <label htmlFor={`reason-${message.id}`}>
                    {reporting
                      ? 'Why are you reporting this message?'
                      : 'Reason for removing this message'}
                  </label>
                  <input
                    id={`reason-${message.id}`}
                    className="rounded-lg bg-background px-2.5 py-1.5"
                    value={reason}
                    maxLength={500}
                    minLength={3}
                    required
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      type="submit"
                      disabled={busy || reason.trim().length < 3}
                    >
                      {reporting ? 'Send report' : 'Remove message'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => {
                        setReporting(false);
                        setModerating(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
              {reported && (
                <span className="text-xs text-muted-foreground">
                  Report sent
                </span>
              )}
            </>
          )}
          {onThread &&
            !message.thread_root_id &&
            (!message.deleted_at || (message.thread_reply_count ?? 0) > 0) && (
              // Layout-only wrapper: it carries the hover reveal, because the
              // button's own disabled opacity would override an opacity-0 on
              // it. An existing thread is a chip that is always shown; "Start
              // thread" docks into the floating toolbar on a wide log, sits in
              // the flow on narrow ones and stays visible on touch screens.
              <span
                className={cn(
                  message.thread_reply_count
                    ? 'mt-1.5 flex'
                    : 'message-thread-start absolute -top-[5px] right-[11px] z-10 flex opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 before:pointer-events-none before:absolute before:top-2 before:-left-[3px] before:h-4 before:w-px before:bg-border @max-[34rem]/message-log:static @max-[34rem]/message-log:mt-0.5 @max-[34rem]/message-log:before:hidden phone:static phone:mt-1 phone:before:hidden [@media(hover:none)]:static [@media(hover:none)]:mt-1 [@media(hover:none)]:opacity-100 [@media(hover:none)]:before:hidden',
                )}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Open thread"
                  className={cn(
                    'gap-1 text-xs',
                    message.thread_reply_count
                      ? 'h-7 gap-1.5 rounded-full border-primary/25 bg-primary/8 px-2.5 font-semibold text-[color-mix(in_oklab,var(--primary)_75%,var(--foreground))] hover:bg-primary/15 hover:text-[color-mix(in_oklab,var(--primary)_75%,var(--foreground))] dark:text-primary dark:hover:bg-primary/15 dark:hover:text-primary'
                      : 'h-8 w-[6.5rem] rounded-lg px-2 font-medium text-muted-foreground hover:text-foreground @max-[34rem]/message-log:w-auto phone:w-auto [@media(hover:none)]:w-auto',
                  )}
                  disabled={busy}
                  onClick={() => onThread(message)}
                >
                  <MessagesSquare size={14} />
                  {message.thread_reply_count
                    ? `${message.thread_reply_count} replies`
                    : 'Start thread'}
                </Button>
              </span>
            )}
        </div>
      </div>
      {historyOpen && !message.deleted_at && <MessageHistory roomId={message.room_id} messageId={message.id} onClose={() => setHistoryOpen(false)} />}
      {reminderOpen && !message.deleted_at && <MessageReminderDialog message={message} onClose={() => setReminderOpen(false)} />}
    </article>
  );
}
