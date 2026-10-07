import {
  Fragment,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import {
  ArrowDown,
  CheckCheck,
  ChevronLeft,
  Search,
  Pin,
  MessagesSquare,
  X,
} from 'lucide-react';
import type { Message, User } from '@/api';
import { api, ApiRequestError } from '@/api';
import MessageItem from './MessageItem';
import MessageComposer from './MessageComposer';
import { MessageBody } from './MessageItem';
import { formatMessagePreview } from './messageFormatting';
import { Button } from '@/components/ui/button';
import {
  conversationSnapshot,
  deleteMessage,
  loadConversation,
  loadPins,
  loadThreads,
  pinMessage,
  markRead,
  reactMessage,
  subscribeConversation,
  writeMessage,
} from './messageStore';
import { openMessageSearch } from './searchEvents';
import { useMessageViewport } from './useMessageViewport';
import { editableMessage, encodeMentions, mentionLabel } from './mentions';
import {
  clearDraft,
  readDraft,
  saveDraft,
  type PendingAttachment,
  type SavedDraft,
} from './drafts';
import { publishTyping, subscribeTyping, typingSnapshot } from './typingStore';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { usePostingState } from './usePostingState';
import {
  subscribeConversationPanels,
  type ConversationPanel,
} from './conversationPanels';
import {
  attachmentSize,
  defaultAttachmentLimits,
  discardPendingAttachment,
  loadAttachmentLimits,
  uploadAttachmentWithProgress,
} from './attachmentFiles';

function StopRestrictedUploads({ cancel }: { cancel: () => void }) {
  useMountEffect(() => {
    cancel();
  });
  return null;
}

function MessageTimeline({
  roomId,
  user,
  label,
  onError,
  targetId,
  canModerate = false,
  canPin = canModerate,
  canPost = true,
  postingReason,
  compactHeader = false,
  onClose,
  threadRootId,
  onOpenThread,
}: {
  roomId: string;
  user: User;
  label: string;
  onError: (message: string) => void;
  targetId?: string;
  canModerate?: boolean;
  canPin?: boolean;
  canPost?: boolean;
  postingReason?: string;
  threadRootId?: string;
  onOpenThread: (message: Message) => void;
  compactHeader?: boolean;
  /** Offered on phones, where the thread covers the button that opened it. */
  onClose?: () => void;
}) {
  const posting = usePostingState(roomId);
  const lifetime = useLifetimeSignal();
  const chat = useSyncExternalStore(
    (listener) => subscribeConversation(roomId, listener, threadRootId),
    () => conversationSnapshot(roomId, threadRootId),
  );
  const anchor =
    chat.anchor &&
    !chat.messages.some((message) => message.id === chat.anchor?.id)
      ? chat.anchor
      : undefined;
  const messages = anchor ? [anchor, ...chat.messages] : chat.messages;
  const [savedDraft] = useState(() => readDraft(user.id, roomId, threadRootId));
  const [draft, setDraft] = useState(savedDraft.body);
  const [attachments, setAttachments] = useState<PendingAttachment[]>(
    savedDraft.attachments,
  );
  const attachmentsRef = useRef(attachments);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const uploadControllers = useRef(new Map<string, AbortController>());
  const [attachmentLimits, setAttachmentLimits] = useState(
    defaultAttachmentLimits,
  );
  const [uploadPhase, setUploadPhase] = useState(false);
  const busyRef = useRef(false);
  const permission = useRef({ restricted: false, reason: '' });
  permission.current = {
    restricted: posting.restricted || !canPost,
    reason: !canPost
      ? postingReason ||
        'Only room administrators can post in this announcement channel.'
      : posting.reason,
  };
  useMountEffect(() => {
    const controller = new AbortController();
    void loadAttachmentLimits(controller.signal)
      .then((limits) => {
        if (!controller.signal.aborted) setAttachmentLimits(limits);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      for (const upload of uploadControllers.current.values()) upload.abort();
      uploadControllers.current.clear();
    };
  });
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState<string | undefined>(targetId);
  const [suggestion, setSuggestion] = useState(0);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const showPanel = (panel: ConversationPanel) => {
    setPinsOpen(panel === 'pins');
    setThreadsOpen(panel === 'threads');
    const setLoading = panel === 'pins' ? setPinsLoading : setThreadsLoading;
    setLoading(true);
    void (panel === 'pins' ? loadPins(roomId) : loadThreads(roomId))
      .catch((error) => {
        if (
          !lifetime().aborted &&
          !(error instanceof DOMException && error.name === 'AbortError')
        )
          onError(
            error instanceof Error ? error.message : `Could not load ${panel}`,
          );
      })
      .finally(() => {
        if (!lifetime().aborted) setLoading(false);
      });
  };
  useMountEffect(() =>
    threadRootId ? undefined : subscribeConversationPanels(roomId, showPanel),
  );
  const mentions = useRef(new Map<string, string>());
  const nonce = useRef<{ fingerprint: string; id: string } | null>(
    savedDraft.nonce && savedDraft.fingerprint
      ? { fingerprint: savedDraft.fingerprint, id: savedDraft.nonce }
      : null,
  );
  const beforeEdit = useRef<SavedDraft | null>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const lastTyping = useRef(0);
  const typing = useSyncExternalStore(
    (listener) => subscribeTyping(roomId, listener, threadRootId),
    () => typingSnapshot(roomId, threadRootId),
  );
  const input = useRef<HTMLTextAreaElement>(null);
  const { viewport, end, nearBottom, awayFromBottom, jump, older } =
    useMessageViewport(
      roomId,
      onError,
      targetId,
      setHighlight,
      threadRootId,
      onOpenThread,
    );
  const stopTyping = () => {
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = undefined;
    if (lastTyping.current) publishTyping(user.id, roomId, false, threadRootId);
    lastTyping.current = 0;
  };
  useMountEffect(() => () => stopTyping());
  const changeDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
    if (!editing) {
      nonce.current = null;
      saveDraft(user.id, roomId, { body: value, attachments }, threadRootId);
      if (value.trim() && !permission.current.restricted) {
        if (Date.now() - lastTyping.current > 2000) {
          publishTyping(user.id, roomId, true, threadRootId);
          lastTyping.current = Date.now();
        }
        if (typingTimeout.current) clearTimeout(typingTimeout.current);
        typingTimeout.current = setTimeout(stopTyping, 4000);
      } else stopTyping();
    }
  };
  const updateAttachments = (next: PendingAttachment[], persist = true) => {
    attachmentsRef.current = next;
    setAttachments(next);
    if (persist)
      saveDraft(
        user.id,
        roomId,
        { body: draftRef.current, attachments: next },
        threadRootId,
      );
  };
  const addFiles = (files: FileList | null) => {
    if (
      busyRef.current ||
      editing ||
      permission.current.restricted ||
      !files?.length
    )
      return;
    const remaining =
      attachmentLimits.max_per_message - attachmentsRef.current.length;
    const selected: File[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      if (file.size < 1) rejected.push(`${file.name} is empty.`);
      else if (file.size > attachmentLimits.max_file_bytes)
        rejected.push(
          `${file.name} exceeds ${attachmentSize(attachmentLimits.max_file_bytes)}.`,
        );
      else if (selected.length >= remaining)
        rejected.push(
          `A message can include ${attachmentLimits.max_per_message} files.`,
        );
      else selected.push(file);
    }
    if (rejected.length) onError([...new Set(rejected)].slice(0, 3).join(' '));
    if (!selected.length) return;
    const next: PendingAttachment[] = [
      ...attachmentsRef.current,
      ...selected.map((file) => ({
        id: '',
        localId: crypto.randomUUID(),
        filename: file.name,
        content_type: file.type,
        size_bytes: file.size,
        file,
        uploadState: 'queued' as const,
      })),
    ];
    nonce.current = null;
    updateAttachments(next);
  };
  const removeFile = (index: number) => {
    if (busyRef.current && !uploadControllers.current.size) return;
    const attachment = attachmentsRef.current[index];
    if (!attachment) return;
    if (attachment.localId)
      uploadControllers.current.get(attachment.localId)?.abort();
    const next = attachmentsRef.current.filter(
      (_, position) => position !== index,
    );
    nonce.current = null;
    updateAttachments(next);
    if (attachment.id)
      void discardPendingAttachment(roomId, attachment.id, lifetime()).catch(
        (error) => {
          if (
            !lifetime().aborted &&
            !(error instanceof ApiRequestError && error.status === 404)
          )
            onError(
              'The file was removed from your draft. Storage cleanup will retry automatically.',
            );
        },
      );
  };
  const addVoiceFile = (file: File, durationMs: number) => {
    if (
      busyRef.current ||
      editing ||
      permission.current.restricted ||
      !attachmentLimits.available ||
      attachmentsRef.current.length >= attachmentLimits.max_per_message ||
      file.size < 1 ||
      file.size > attachmentLimits.max_voice_note_bytes
    ) {
      onError(
        `Choose up to ${attachmentLimits.max_per_message} files. Voice notes must be ${attachmentSize(attachmentLimits.max_voice_note_bytes)} or less.`,
      );
      return false;
    }
    const next: PendingAttachment[] = [
      ...attachmentsRef.current,
      {
        id: '',
        localId: crypto.randomUUID(),
        filename: file.name,
        content_type: file.type,
        size_bytes: file.size,
        file,
        voice_note: true,
        duration_ms: durationMs,
        uploadState: 'queued',
      },
    ];
    nonce.current = null;
    updateAttachments(next);
    return true;
  };
  const uploadFile = async (localId: string) => {
    const attachment = attachmentsRef.current.find(
      (item) => item.localId === localId,
    );
    if (!attachment || attachment.id) return;
    if (!attachment.file)
      throw new Error('Choose the file again before sending.');
    if (permission.current.restricted)
      throw new Error(permission.current.reason);
    const controller = new AbortController();
    const parentSignal = lifetime();
    const abort = () => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    if (parentSignal.aborted) controller.abort();
    uploadControllers.current.set(localId, controller);
    const updateFile = (patch: Partial<PendingAttachment>, persist = true) => {
      if (parentSignal.aborted) return;
      updateAttachments(
        attachmentsRef.current.map((item) =>
          item.localId === localId ? { ...item, ...patch } : item,
        ),
        persist,
      );
    };
    updateFile({
      uploadState: 'uploading',
      progress: 0,
      uploadError: undefined,
    });
    try {
      const uploaded = await uploadAttachmentWithProgress(
        roomId,
        attachment.file,
        {
          signal: controller.signal,
          voiceNote: attachment.voice_note,
          durationMs: attachment.duration_ms,
          onProgress: (progress) => updateFile({ progress }, false),
        },
      );
      if (parentSignal.aborted) return;
      if (!attachmentsRef.current.some((item) => item.localId === localId)) {
        void discardPendingAttachment(roomId, uploaded.id, parentSignal).catch(
          () => {},
        );
        return;
      }
      updateFile({
        ...uploaded,
        uploadState: 'ready',
        progress: 100,
        uploadError: undefined,
      });
      if (permission.current.restricted)
        throw new Error(permission.current.reason);
    } catch (error) {
      if (parentSignal.aborted) throw error;
      const cancelled = controller.signal.aborted;
      if (!attachmentsRef.current.find((item) => item.localId === localId)?.id)
        updateFile({
          uploadState: cancelled ? 'cancelled' : 'failed',
          uploadError: cancelled
            ? 'Upload cancelled. Your file and draft are still here.'
            : error instanceof Error
              ? error.message
              : 'Could not upload this file.',
        });
      throw error;
    } finally {
      parentSignal.removeEventListener('abort', abort);
      if (uploadControllers.current.get(localId) === controller)
        uploadControllers.current.delete(localId);
    }
  };
  const cancelUpload = (index: number) => {
    const attachment = attachmentsRef.current[index];
    if (attachment?.localId)
      uploadControllers.current.get(attachment.localId)?.abort();
  };
  const runMessageAction = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
      return true;
    } catch (error) {
      if (lifetime().aborted) return false;
      if (error instanceof DOMException && error.name === 'AbortError')
        return false;
      if (
        error instanceof ApiRequestError &&
        ['posting_restricted', 'slow_mode'].includes(error.code ?? '')
      )
        void posting.refresh();
      onError(error instanceof Error ? error.message : 'Message action failed');
      return false;
    } finally {
      busyRef.current = false;
      if (!lifetime().aborted) setBusy(false);
    }
  };
  const retryFile = (index: number) => {
    const attachment = attachmentsRef.current[index];
    if (
      !attachment?.localId ||
      permission.current.restricted ||
      busyRef.current
    )
      return;
    void runMessageAction(async () => {
      setUploadPhase(true);
      try {
        await uploadFile(attachment.localId!);
      } finally {
        if (!lifetime().aborted) setUploadPhase(false);
      }
    });
  };
  const send = (event?: FormEvent) => {
    event?.preventDefault();
    if (
      (!draft.trim() && (editing || !attachmentsRef.current.length)) ||
      busyRef.current ||
      permission.current.restricted ||
      (!editing && posting.cooldown)
    )
      return;
    const body = encodeMentions(draft.trim(), mentions.current);
    const submitMessage = async () => {
      if (editing) {
        await writeMessage(roomId, body, undefined, editing.id);
        if (lifetime().aborted) return;
        const saved = beforeEdit.current;
        setDraft(saved?.body ?? '');
        beforeEdit.current = null;
      } else {
        const pendingIds = attachmentsRef.current
          .filter((item) => !item.id)
          .map((item) => item.localId);
        setUploadPhase(true);
        try {
          for (const localId of pendingIds) {
            if (!localId)
              throw new Error('Choose the file again before sending.');
            await uploadFile(localId);
            if (lifetime().aborted) return;
          }
        } finally {
          if (!lifetime().aborted) setUploadPhase(false);
        }
        if (permission.current.restricted)
          throw new Error(permission.current.reason);
        const ready = attachmentsRef.current;
        if (!body && !ready.length) return;
        const ids = ready.map((item) => item.id);
        const fingerprint = JSON.stringify([
          body,
          reply?.id ?? '',
          ids,
          threadRootId ?? '',
        ]);
        if (nonce.current?.fingerprint !== fingerprint)
          nonce.current = { fingerprint, id: crypto.randomUUID() };
        saveDraft(
          user.id,
          roomId,
          {
            body: draft,
            attachments: ready,
            nonce: nonce.current.id,
            fingerprint,
          },
          threadRootId,
        );
        await writeMessage(
          roomId,
          body,
          reply?.id,
          undefined,
          ids,
          nonce.current.id,
          threadRootId,
        );
        if (lifetime().aborted) return;
        nonce.current = null;
        attachmentsRef.current = [];
        setAttachments([]);
        setDraft('');
        clearDraft(user.id, roomId, threadRootId);
      }
      setReply(null);
      setEditing(null);
      mentions.current.clear();
      stopTyping();
      nearBottom.current = true;
      if (viewport.current)
        viewport.current.scrollTop = viewport.current.scrollHeight;
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
    if (permission.current.restricted) {
      onError(permission.current.reason);
      return;
    }
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
  const firstUnread =
    chat.unreadBoundary === undefined
      ? -1
      : messages.findIndex(
          (message) =>
            message.author.id !== user.id &&
            (message.sequence ?? 0) > chat.unreadBoundary!,
        );
  const typingNames = typing
    .map((id) => chat.members.find((member) => member.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  return (
    <div
      className="message-thread relative flex min-h-0 flex-1 flex-col select-text"
      aria-label={threadRootId ? 'Thread messages' : 'Conversation messages'}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect =
            busy || editing || permission.current.restricted ? 'none' : 'copy';
        }
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        addFiles(event.dataTransfer.files);
      }}
    >
      {permission.current.restricted && (
        <StopRestrictedUploads
          cancel={() => {
            for (const controller of uploadControllers.current.values())
              controller.abort();
          }}
        />
      )}
      <div
        className={
          compactHeader
            ? 'thread-tools flex shrink-0 items-center justify-end gap-1 border-b px-3 py-1 text-xs phone:hidden'
            : 'thread-tools flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 text-xs'
        }
      >
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className={
              threadRootId
                ? 'shrink-0'
                : '-ml-1 hidden shrink-0 phone:inline-flex phone:size-11'
            }
            aria-label={threadRootId ? 'Close thread' : 'Close room messages'}
            onClick={onClose}
          >
            <ChevronLeft size={20} />
          </Button>
        )}
        {!compactHeader && (
          <span className="min-w-0 flex-1 truncate phone:text-sm phone:font-semibold">
            {label}
          </span>
        )}
        {!threadRootId && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="phone:size-11"
            aria-label="Conversation threads"
            disabled={threadsLoading}
            onClick={() => {
              if (threadsOpen) setThreadsOpen(false);
              else showPanel('threads');
            }}
          >
            <MessagesSquare size={14} />
          </Button>
        )}
        {!threadRootId && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="phone:size-11"
            aria-label="Pinned messages"
            disabled={pinsLoading}
            onClick={() => {
              if (pinsOpen) setPinsOpen(false);
              else showPanel('pins');
            }}
          >
            <Pin size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="phone:size-11"
          aria-label="Search this conversation"
          onClick={() => openMessageSearch(roomId)}
        >
          <Search size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          // A phone header has room for the conversation's name or this label,
          // not both; the icon keeps the same accessible name.
          className="phone:size-11 phone:px-0"
          aria-label="Mark as read"
          onClick={() => {
            const last = chat.messages.at(-1);
            if (last)
              void markRead(roomId, last, threadRootId).catch((error) =>
                onError(
                  error instanceof Error
                    ? error.message
                    : 'Could not mark messages as read',
                ),
              );
          }}
        >
          <CheckCheck className="hidden phone:block" size={18} />
          <span className="phone:hidden">Mark as read</span>
        </Button>
      </div>
      {threadsOpen && !threadRootId && (
        <section
          className="max-h-56 shrink-0 overflow-auto border-b p-3"
          aria-label="Conversation threads"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <strong className="text-xs">Conversation threads</strong>
            <Button
              variant="ghost"
              size="icon-sm"
              className="phone:size-11"
              aria-label="Close conversation threads"
              onClick={() => setThreadsOpen(false)}
            >
              <X size={16} />
            </Button>
          </div>
          {!chat.threads?.length && (
            <p className="text-xs text-muted-foreground">
              {threadsLoading
                ? 'Loading threads…'
                : 'No threads yet. Open a thread from a message.'}
            </p>
          )}
          {chat.threads?.map((message) => (
            <button
              key={message.id}
              type="button"
              className="mb-2 block w-full rounded-lg border p-2 text-left text-xs hover:bg-accent"
              onClick={() => {
                setThreadsOpen(false);
                onOpenThread(message);
              }}
            >
              <strong>{message.author.name}</strong>
              <span className="ml-2 line-clamp-2 whitespace-pre-wrap">
                {message.deleted_at
                  ? 'Message deleted'
                  : formatMessagePreview(message.body) || '[attachment]'}
              </span>
              <span className="mt-1 block text-muted-foreground">
                {message.thread_reply_count ?? 0} replies
                {message.thread_unread_count
                  ? ` · ${message.thread_unread_count} unread`
                  : ''}
              </span>
            </button>
          ))}
          {chat.threadBefore && (
            <Button
              variant="outline"
              size="sm"
              disabled={threadsLoading}
              onClick={() => {
                setThreadsLoading(true);
                void loadThreads(roomId, true)
                  .catch((error) => {
                    if (!lifetime().aborted)
                      onError(
                        error instanceof Error
                          ? error.message
                          : 'Could not load threads',
                      );
                  })
                  .finally(() => {
                    if (!lifetime().aborted) setThreadsLoading(false);
                  });
              }}
            >
              More threads
            </Button>
          )}
        </section>
      )}
      {pinsOpen && !threadRootId && (
        <section
          className="max-h-48 shrink-0 overflow-auto border-b p-3"
          aria-label="Pinned messages"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <strong className="text-xs">Pinned messages</strong>
            <Button
              variant="ghost"
              size="icon-sm"
              className="phone:size-11"
              aria-label="Close pinned messages"
              onClick={() => setPinsOpen(false)}
            >
              <X size={16} />
            </Button>
          </div>
          {!chat.pins?.length && (
            <p className="text-xs text-muted-foreground">
              {pinsLoading ? 'Loading pins…' : 'No pinned messages.'}
            </p>
          )}
          {chat.pins?.map((message) => (
            <button
              key={message.id}
              type="button"
              className="mb-2 block w-full rounded-lg border p-2 text-left text-xs hover:bg-accent"
              onClick={() => {
                setPinsOpen(false);
                if (message.thread_root_id) onOpenThread(message);
                else void jump(message.id);
              }}
            >
              <strong>{message.author.name}</strong>
              <span className="ml-2 line-clamp-2 whitespace-pre-wrap">
                {formatMessagePreview(message.body) || '[attachment]'}
              </span>
            </button>
          ))}
        </section>
      )}
      {threadRootId && chat.root && (
        <div
          className="max-h-40 shrink-0 overflow-auto border-b bg-muted/30 p-3 text-sm"
          aria-label="Thread original message"
        >
          <strong className="block text-xs">{chat.root.author.name}</strong>
          {chat.root.deleted_at ? (
            <span className="italic text-muted-foreground">
              Message deleted
            </span>
          ) : (
            <MessageBody message={chat.root} />
          )}
        </div>
      )}
      <div
        ref={viewport}
        className="message-log min-h-0 flex-1 overflow-auto overscroll-contain p-3 phone:px-2 phone:py-3"
        role="log"
        aria-label={threadRootId ? 'Thread replies' : 'Messages'}
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
              onClick={() => void loadConversation(roomId, false, threadRootId)}
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
            {(index === 0 ||
              new Date(messages[index - 1].created_at).toDateString() !==
                new Date(message.created_at).toDateString()) && (
              <div
                className="my-4 flex items-center gap-3 text-xs text-muted-foreground"
                role="separator"
                aria-label={new Date(message.created_at).toLocaleDateString(
                  undefined,
                  { dateStyle: 'long' },
                )}
              >
                <span className="h-px flex-1 bg-border" />
                <span>
                  {new Date(message.created_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            {index === firstUnread && (
              <p className="my-3 border-t border-primary pt-1 text-center text-xs font-medium text-primary">
                New messages
              </p>
            )}
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
              onThread={!threadRootId ? onOpenThread : undefined}
              canPin={canPin}
              onPin={(message, remove) =>
                runMessageAction(() => pinMessage(roomId, message.id, remove))
              }
              onReact={(message, emoji, remove) =>
                posting.restricted
                  ? (onError(posting.reason), Promise.resolve(false))
                  : runMessageAction(() =>
                      reactMessage(roomId, message.id, emoji, remove),
                    )
              }
              onDelete={(message) =>
                runMessageAction(() => removeMessage(message))
              }
              onReport={(message, reason) =>
                runMessageAction(() =>
                  api(`/rooms/${roomId}/messages/${message.id}/reports`, {
                    reason,
                  }),
                )
              }
              onModerate={(message, reason) =>
                runMessageAction(() =>
                  api(
                    `/rooms/${roomId}/messages/${message.id}/moderation`,
                    { reason },
                    'DELETE',
                  ).then(() => loadConversation(roomId, false, threadRootId)),
                )
              }
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
            if (viewport.current)
              viewport.current.scrollTop = viewport.current.scrollHeight;
          }}
        >
          <ArrowDown size={14} />
          Jump to latest
        </Button>
      )}
      {typingNames.length > 0 && (
        <p className="px-4 py-1 text-xs text-muted-foreground" role="status">
          {typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'}{' '}
          typing…
        </p>
      )}
      <MessageComposer
        roomId={roomId}
        userId={user.id}
        recordingKey={`${user.id}:${roomId}:${threadRootId ?? ''}`}
        draft={draft}
        onDraft={changeDraft}
        editing={!!editing}
        reply={reply}
        busy={busy}
        blocked={
          permission.current.restricted || (!editing && posting.cooldown)
        }
        blockedReason={permission.current.reason || posting.reason}
        blockedUntil={posting.until}
        attachmentsBlocked={
          permission.current.restricted || !attachmentLimits.available
        }
        attachmentsBlockedReason={
          !attachmentLimits.available
            ? 'File storage is unavailable. Your draft stays here; try again once storage is configured.'
            : permission.current.reason
        }
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
        onVoiceFile={addVoiceFile}
        onRemoveFile={removeFile}
        onCancelUpload={cancelUpload}
        onRetryFile={retryFile}
        attachmentsMutable={!busy || uploadPhase}
        maxAttachments={attachmentLimits.max_per_message}
        maxFileBytes={attachmentLimits.max_file_bytes}
        onTypingStop={stopTyping}
      />
    </div>
  );
}

export default function MessageThread(props: {
  roomId: string;
  user: User;
  label: string;
  onError: (message: string) => void;
  targetId?: string;
  canModerate?: boolean;
  canPin?: boolean;
  canPost?: boolean;
  postingReason?: string;
  compactHeader?: boolean;
  onClose?: () => void;
}) {
  const [thread, setThread] = useState<{
    root: string;
    target?: string;
  } | null>(null);
  useMountEffect(() =>
    subscribeConversationPanels(props.roomId, () => setThread(null)),
  );
  const openThread = (message: Message) => {
    setThread({
      root: message.thread_root_id ?? message.id,
      target: message.thread_root_id ? message.id : undefined,
    });
  };
  return (
    <div className="@container/message-conversation flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div
        className={`${thread ? '@max-[650px]/message-conversation:hidden ' : ''}flex min-h-0 min-w-0 flex-1 flex-col`}
      >
        <MessageTimeline
          key={`${props.user.id}:${props.roomId}:${props.targetId ?? ''}`}
          {...props}
          onOpenThread={openThread}
        />
      </div>
      {thread && (
        <aside
          className="flex min-h-0 min-w-0 flex-1 flex-col border-l bg-background @min-[650px]/message-conversation:max-w-lg"
          aria-label="Message thread"
        >
          <MessageTimeline
            key={`${props.user.id}:${props.roomId}:${thread.root}:${thread.target ?? ''}`}
            {...props}
            label="Thread replies"
            compactHeader={false}
            threadRootId={thread.root}
            targetId={thread.target}
            onClose={() => setThread(null)}
            onOpenThread={openThread}
          />
        </aside>
      )}
    </div>
  );
}
