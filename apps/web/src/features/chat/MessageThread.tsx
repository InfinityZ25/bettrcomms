import {
  Fragment,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { ArrowDown, Search } from 'lucide-react';
import type { Message, User } from '@/api';
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

export default function MessageThread({
  roomId,
  user,
  label,
  onError,
  targetId,
}: {
  roomId: string;
  user: User;
  label: string;
  onError: (message: string) => void;
  targetId?: string;
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
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState<string | undefined>(targetId);
  const [suggestion, setSuggestion] = useState(0);
  const mentions = useRef(new Map<string, string>());
  const input = useRef<HTMLTextAreaElement>(null);
  const { viewport, end, nearBottom, awayFromBottom, jump, older } =
    useMessageViewport(roomId, onError, targetId, setHighlight);
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
    if (!draft.trim() || busy) return;
    const body = encodeMentions(draft.trim(), mentions.current);
    const submitMessage = async () => {
      await writeMessage(roomId, body, reply?.id, editing?.id);
      setDraft('');
      setReply(null);
      setEditing(null);
      mentions.current.clear();
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
      setDraft('');
      mentions.current.clear();
    }
  };
  const startEdit = (message: Message) => {
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
    setDraft(draft.replace(/@([^@\n<>]*)$/, label + ' '));
    setSuggestion(0);
    input.current?.focus();
  };
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col select-text"
      aria-label="Conversation messages"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
        <span className="truncate">{label}</span>
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
        {messages.map((message) => (
          <Fragment key={message.id}>
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
      <MessageComposer
        draft={draft}
        onDraft={setDraft}
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
            setDraft('');
            mentions.current.clear();
          }
          setEditing(null);
          setReply(null);
        }}
        inputRef={input}
        label={label}
      />
    </div>
  );
}
