import {
  Fragment,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { ArrowDown, ChevronLeft, Search } from 'lucide-react';
import type { Message, User } from '@/api';
import { api, uploadMessageAttachment } from '@/api';
import MessageItem from './MessageItem';
import MessageComposer from './MessageComposer';
import { Button } from '@/components/ui/button';
import {
  conversationSnapshot,
  deleteMessage,
  loadConversation,
  markRead,
  reactMessage,
  subscribeConversation,
  writeMessage,
} from './messageStore';
import { openMessageSearch } from './searchEvents';
import { useMessageViewport } from './useMessageViewport';
import { editableMessage, encodeMentions, mentionLabel } from './mentions';
import { clearDraft, readDraft, saveDraft, type PendingAttachment, type SavedDraft } from './drafts';
import { publishTyping, subscribeTyping, typingSnapshot } from './typingStore';
import { useMountEffect } from '@/hooks/useMountEffect';

export default function MessageThread({
  roomId,
  user,
  label,
  onError,
  targetId,
  canModerate = false,
  onClose,
}: {
  roomId: string;
  user: User;
  label: string;
  onError: (message: string) => void;
  targetId?: string;
  canModerate?: boolean;
  /** Offered on phones, where the thread covers the button that opened it. */
  onClose?: () => void;
}) {
  const chat = useSyncExternalStore(
    (listener) => subscribeConversation(roomId, listener),
    () => conversationSnapshot(roomId),
  );
  const anchor =
    chat.anchor &&
    !chat.messages.some((message) => message.id === chat.anchor?.id)
      ? chat.anchor
      : undefined;
  const messages = anchor ? [anchor, ...chat.messages] : chat.messages;
  const [savedDraft] = useState(() => readDraft(user.id, roomId));
  const [draft, setDraft] = useState(savedDraft.body);
  const [attachments, setAttachments] = useState<PendingAttachment[]>(savedDraft.attachments);
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState<string | undefined>(targetId);
  const [suggestion, setSuggestion] = useState(0);
  const mentions = useRef(new Map<string, string>());
  const nonce = useRef<{ fingerprint: string; id: string } | null>(
    savedDraft.nonce && savedDraft.fingerprint
      ? { fingerprint: savedDraft.fingerprint, id: savedDraft.nonce }
      : null,
  );
  const beforeEdit = useRef<SavedDraft | null>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTyping = useRef(0);
  const typing = useSyncExternalStore(
    (listener) => subscribeTyping(roomId, listener),
    () => typingSnapshot(roomId),
  );
  const input = useRef<HTMLTextAreaElement>(null);
  const { viewport, end, nearBottom, awayFromBottom, jump, older } =
    useMessageViewport(roomId, onError, targetId, setHighlight);
  const stopTyping = () => {
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = undefined;
    if (lastTyping.current) publishTyping(user.id, roomId, false);
    lastTyping.current = 0;
  };
  useMountEffect(() => () => stopTyping());
  const changeDraft = (value: string) => {
    setDraft(value);
    if (!editing) {
      nonce.current = null;
      saveDraft(user.id, roomId, { body: value, attachments });
      if (value.trim()) {
        if (Date.now() - lastTyping.current > 2000) {
          publishTyping(user.id, roomId, true);
          lastTyping.current = Date.now();
        }
        if (typingTimeout.current) clearTimeout(typingTimeout.current);
        typingTimeout.current = setTimeout(stopTyping, 4000);
      } else stopTyping();
    }
  };
  const addFiles = (files: FileList | null) => {
    if (busy || !files?.length) return;
    const selected = Array.from(files);
    if (attachments.length + selected.length > 4 || selected.some((file) => file.size < 1 || file.size > 10 * 1024 * 1024)) {
      onError('Choose up to four files, each 10 MB or less.');
      return;
    }
    const next: PendingAttachment[] = [...attachments, ...selected.map((file) => ({ id: '', localId: crypto.randomUUID(), filename: file.name, content_type: file.type, size_bytes: file.size, file }))];
    setAttachments(next);
    nonce.current = null;
    saveDraft(user.id, roomId, { body: draft, attachments: next });
  };
  const removeFile = (index: number) => {
    const next = attachments.filter((_, position) => position !== index);
    setAttachments(next);
    nonce.current = null;
    saveDraft(user.id, roomId, { body: draft, attachments: next });
  };
  const runMessageAction = async (action: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(true);
    try {
      await action();
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Message action failed');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const send = (event?: FormEvent) => {
    event?.preventDefault();
    if ((!draft.trim() && (editing || !attachments.length)) || busy) return;
    const body = encodeMentions(draft.trim(), mentions.current);
    const submitMessage = async () => {
      if (editing) {
        await writeMessage(roomId, body, undefined, editing.id);
        const saved = beforeEdit.current;
        setDraft(saved?.body ?? '');
        beforeEdit.current = null;
      } else {
        const ready = [...attachments];
        for (let index = 0; index < ready.length; index++) {
          if (ready[index].id) continue;
          if (!ready[index].file) throw new Error('Choose the file again before sending.');
          ready[index] = await uploadMessageAttachment(roomId, ready[index].file!);
          setAttachments([...ready]);
          saveDraft(user.id, roomId, { body: draft, attachments: ready });
        }
        const ids = ready.map((item) => item.id);
        const fingerprint = JSON.stringify([body, reply?.id ?? '', ids]);
        if (nonce.current?.fingerprint !== fingerprint) nonce.current = { fingerprint, id: crypto.randomUUID() };
        saveDraft(user.id, roomId, { body: draft, attachments: ready, nonce: nonce.current.id, fingerprint });
        await writeMessage(roomId, body, reply?.id, undefined, ids, nonce.current.id);
        nonce.current = null;
        setAttachments([]);
        setDraft('');
        clearDraft(user.id, roomId);
      }
      setReply(null);
      setEditing(null);
      mentions.current.clear();
      stopTyping();
      nearBottom.current = true;
      end.current?.scrollIntoView({ block: 'end' });
      input.current?.focus();
    };
    void runMessageAction(submitMessage);
  };
  const removeMessage = async (message: Message) => {
    await deleteMessage(roomId, message.id);
    if (editing?.id === message.id) {
      setEditing(null);
      setDraft(beforeEdit.current?.body ?? '');
      beforeEdit.current = null;
      mentions.current.clear();
    }
  };
  const startEdit = (message: Message) => {
    beforeEdit.current = { body: draft, attachments };
    const { body, mentions: selected } = editableMessage(message, chat.members);
    mentions.current = selected;
    setDraft(body);
    setEditing(message);
    setReply(null);
    input.current?.focus();
  };
  const query = draft.match(/@([^@\n<>]*)$/)?.[1];
  const suggested =
    query === undefined
      ? []
      : chat.members
          .filter((person) =>
            person.name.toLowerCase().includes(query.toLowerCase()),
          )
          .slice(0, 6);
  const mention = (person: User) => {
    const label = mentionLabel(person, chat.members);
    mentions.current.set(label, person.id);
    changeDraft(draft.replace(/@([^@\n<>]*)$/, label + ' '));
    setSuggestion(0);
    input.current?.focus();
  };
  const firstUnread = chat.unreadBoundary === undefined
    ? -1
    : messages.findIndex((message) => message.author.id !== user.id && (message.sequence ?? 0) > chat.unreadBoundary!);
  const typingNames = typing
    .map((id) => chat.members.find((member) => member.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col select-text"
      aria-label="Conversation messages"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="-ml-1 hidden shrink-0 phone:inline-flex"
            aria-label="Close room messages"
            onClick={onClose}
          >
            <ChevronLeft size={20} />
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Search this conversation"
          onClick={() => openMessageSearch(roomId)}
        >
          <Search size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const last = chat.messages.at(-1);
            if (last)
              void markRead(roomId, last).catch((error) =>
                onError(
                  error instanceof Error
                    ? error.message
                    : 'Could not mark messages as read',
                ),
              );
          }}
        >
          Mark as read
        </Button>
      </div>
      <div
        ref={viewport}
        className="min-h-0 flex-1 overflow-auto p-3"
        role="log"
        aria-label="Messages"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={() => {
          const node = viewport.current;
          if (node)
            nearBottom.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
      >
        {chat.before && (
          <Button
            variant="outline"
            size="sm"
            className="mb-4 w-full"
            disabled={chat.loadingOlder}
            onClick={() => void older()}
          >
            {chat.loadingOlder
              ? 'Loading older messages…'
              : 'Load older messages'}
          </Button>
        )}
        {chat.loading && !chat.messages.length && (
          <p role="status" className="p-3 text-xs text-muted-foreground">
            Opening the conversation…
          </p>
        )}
        {chat.error && (
          <div role="alert" className="p-3 text-xs text-destructive">
            {chat.error}
            <Button
              variant="ghost"
              onClick={() => void loadConversation(roomId)}
            >
              Retry
            </Button>
          </div>
        )}
        {!chat.loading && !chat.messages.length && !chat.error && (
          <p className="p-6 text-sm text-muted-foreground">
            The conversation starts here. Say hello.
          </p>
        )}
        {messages.map((message, index) => (
          <Fragment key={message.id}>
            {index === firstUnread && <p className="my-3 border-t border-primary pt-1 text-center text-xs font-medium text-primary">New messages</p>}
            {anchor?.id === message.id && (
              <p className="mb-2 text-xs text-muted-foreground">
                Earlier message — load older messages for surrounding history.
              </p>
            )}
            <MessageItem
              message={message}
              userId={user.id}
              highlighted={highlight === message.id}
              busy={busy}
              onJump={(id) => void jump(id)}
              onReply={(message) => {
                setReply(message);
                setEditing(null);
                input.current?.focus();
              }}
              onEdit={startEdit}
              onReact={(message, emoji, remove) =>
                runMessageAction(() =>
                  reactMessage(roomId, message.id, emoji, remove),
                )
              }
              onDelete={(message) =>
                runMessageAction(() => removeMessage(message))
              }
              onReport={(message, reason) => runMessageAction(() => api(`/rooms/${roomId}/messages/${message.id}/reports`, { reason }))}
              onModerate={(message, reason) => runMessageAction(() => api(`/rooms/${roomId}/messages/${message.id}/moderation`, { reason }, 'DELETE').then(() => loadConversation(roomId)))}
              canModerate={canModerate}
              onError={onError}
            />
            {anchor?.id === message.id && (
              <p className="my-3 border-t pt-2 text-xs text-muted-foreground">
                Recent messages
              </p>
            )}
          </Fragment>
        ))}
        <div ref={end} className="h-px" />
      </div>
      {awayFromBottom && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-28 left-1/2 -translate-x-1/2 shadow-lg"
          onClick={() => {
            setHighlight(undefined);
            nearBottom.current = true;
            end.current?.scrollIntoView({ block: 'end' });
          }}
        >
          <ArrowDown size={14} />
          Jump to latest
        </Button>
      )}
      {typingNames.length > 0 && (
        <p className="px-4 py-1 text-xs text-muted-foreground" role="status">{typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing…</p>
      )}
      <MessageComposer
        draft={draft}
        onDraft={changeDraft}
        editing={!!editing}
        reply={reply}
        busy={busy}
        suggested={suggested}
        suggestion={suggestion}
        onSuggestion={setSuggestion}
        onMention={mention}
        onSend={send}
        onCancel={() => {
          if (editing) {
            setDraft(beforeEdit.current?.body ?? '');
            beforeEdit.current = null;
            mentions.current.clear();
          }
          setEditing(null);
          setReply(null);
        }}
        inputRef={input}
        label={label}
        attachments={editing ? [] : attachments}
        onFiles={addFiles}
        onRemoveFile={removeFile}
        onTypingStop={stopTyping}
      />
    </div>
  );
}
