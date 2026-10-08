import {
  useRef,
  useState,
  type FormEvent,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  AtSign,
  Bold,
  Check,
  Code,
  Italic,
  Mic,
  Paperclip,
  Quote,
  Send,
  Upload,
  X,
  EyeOff,
  Smile,
} from 'lucide-react';
import type { Message, User } from '@/api';
import type { PendingAttachment } from './drafts';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import {
  formatMessagePreview,
  formatSelection,
  type FormatKind,
} from './messageFormatting';
import EmojiDialog from './EmojiDialog';
import { insertEmoji } from './emojiCatalog';
import VoiceNoteComposer from './VoiceNoteComposer';
import PendingAttachmentCard from './PendingAttachmentCard';
import { attachmentSize } from './attachmentFiles';

type MessageComposerProps = {
  draft: string;
  onDraft: (value: string) => void;
  editing: boolean;
  reply: Message | null;
  busy: boolean;
  suggested: User[];
  suggestion: number;
  onSuggestion: Dispatch<SetStateAction<number>>;
  onMention: (person: User) => void;
  onSend: (event?: FormEvent) => void;
  onCancel: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  label: string;
  attachments: PendingAttachment[];
  onFiles: (files: FileList | null) => void;
  onRemoveFile: (index: number) => void;
  onCancelUpload?: (index: number) => void;
  onRetryFile?: (index: number) => void;
  attachmentsMutable?: boolean;
  maxAttachments?: number;
  maxFileBytes?: number;
  roomId?: string;
  onTypingStop: () => void;
  blocked?: boolean;
  blockedReason?: string;
  blockedUntil?: string;
  attachmentsBlocked?: boolean;
  attachmentsBlockedReason?: string;
  userId?: string;
  recordingKey?: string;
  onVoiceFile?: (file: File, durationMs: number) => boolean | void;
};

export default function MessageComposer(props: MessageComposerProps) {
  return (
    <ScopedMessageComposer
      key={`${props.userId ?? ''}:${props.recordingKey ?? ''}`}
      {...props}
    />
  );
}

function ScopedMessageComposer({
  draft,
  onDraft,
  editing,
  reply,
  busy,
  suggested,
  suggestion,
  onSuggestion,
  onMention,
  onSend,
  onCancel,
  inputRef,
  label,
  attachments,
  onFiles,
  onRemoveFile,
  onCancelUpload,
  onRetryFile,
  attachmentsMutable = !busy,
  maxAttachments = 4,
  maxFileBytes = 500 * 1024 * 1024,
  roomId,
  onTypingStop,
  blocked = false,
  blockedReason,
  blockedUntil,
  attachmentsBlocked = blocked,
  attachmentsBlockedReason,
  userId,
  onVoiceFile,
}: MessageComposerProps) {
  const phone = useIsMobile();
  const fileInput = useRef<HTMLInputElement>(null);
  const [choosingEmoji, setChoosingEmoji] = useState(false);
  const [recording, setRecording] = useState(false);
  const [formatError, setFormatError] = useState('');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const emojiSelection = useRef({ start: 0, end: 0 });
  const uploading = attachments.some(
    (attachment) => attachment.uploadState === 'uploading',
  );
  const filesAllowed =
    !editing &&
    !busy &&
    !attachmentsBlocked &&
    attachments.length < maxAttachments;
  const voiceAllowed =
    !editing &&
    !blocked &&
    !attachmentsBlocked &&
    !busy &&
    attachments.length < maxAttachments &&
    Boolean(onVoiceFile);
  const voiceOpen = recording;
  const voiceUnavailableReason = attachmentsBlocked
    ? attachmentsBlockedReason ||
      blockedReason ||
      'Posting permission is restricted in this conversation.'
    : busy
      ? 'Your voice note stays here while the current message action finishes.'
      : editing
        ? 'Finish or cancel editing before attaching your voice note.'
        : attachments.length >= maxAttachments
          ? 'Remove an attachment before attaching your voice note.'
          : blocked
            ? blockedReason ||
              'Wait until sending is available before attaching your voice note.'
            : !onVoiceFile
              ? 'Voice notes are unavailable in this conversation.'
              : undefined;
  const format = (kind: FormatKind) => {
    const field = inputRef.current;
    const result = formatSelection(
      draft,
      field?.selectionStart ?? draft.length,
      field?.selectionEnd ?? draft.length,
      kind,
    );
    if (result.value.length > 4000) {
      setFormatError('The message limit is 4,000 characters.');
      return;
    }
    setFormatError('');
    onDraft(result.value);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(result.start, result.end);
    });
  };
  return (
    <form
      className="message-composer relative m-3 shrink-0 rounded-2xl border bg-muted/60 p-2 phone:m-2 phone:p-1 focus-within:ring-2 focus-within:ring-ring/40"
      onSubmit={(event) => {
        if (busy || blocked || voiceOpen) event.preventDefault();
        else onSend(event);
      }}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        dragDepth.current++;
        if (filesAllowed) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = filesAllowed ? 'copy' : 'none';
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        if (filesAllowed) onFiles(event.dataTransfer.files);
      }}
    >
      {dragging && filesAllowed && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-background/95 p-3">
          <Upload className="text-primary" size={24} />
          <strong className="text-sm">Drop files to attach</strong>
          <span className="text-xs text-muted-foreground">
            Up to {attachmentSize(maxFileBytes)} each · preview before sending
          </span>
        </div>
      )}
      {(editing || reply) && (
        <div className="mb-2 flex items-center gap-2 border-b pb-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            {editing
              ? 'Editing your message'
              : `Replying to ${reply?.author.name}: ${formatMessagePreview(reply?.body ?? '')}`}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label="Cancel reply or edit"
            disabled={busy}
            onClick={() => {
              onCancel();
            }}
          >
            <X size={14} />
          </Button>
        </div>
      )}
      {!!suggested.length && (
        <div
          className="absolute right-0 bottom-full left-0 mb-1 rounded-xl border bg-popover p-1 shadow-lg"
          role="listbox"
          aria-label="Mention a member"
        >
          {suggested.map((person, index) => (
            <button
              type="button"
              role="option"
              aria-selected={suggestion % suggested.length === index}
              key={person.id}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs',
                suggestion % suggested.length === index && 'bg-accent',
              )}
              onClick={() => onMention(person)}
            >
              <AtSign size={14} />
              {person.name}
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div
          className="mb-2 grid max-h-72 grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-2 overflow-y-auto overscroll-contain p-1"
          aria-label="Files to attach"
        >
          {attachments.map((attachment, index) => (
            <PendingAttachmentCard
              key={`${attachment.localId || attachment.id}:${attachment.file ? 'local' : 'remote'}`}
              attachment={attachment}
              roomId={roomId}
              removable={attachmentsMutable}
              retryable={!busy && !attachmentsBlocked}
              onRemove={() => onRemoveFile(index)}
              onCancel={() => onCancelUpload?.(index)}
              onRetry={() => onRetryFile?.(index)}
            />
          ))}
        </div>
      )}
      {choosingEmoji && (
        <EmojiDialog
          userId={userId}
          onClose={() => {
            setChoosingEmoji(false);
            inputRef.current?.focus();
          }}
          onSelect={(emoji) => {
            const selected = emojiSelection.current;
            const next = insertEmoji(
              draft,
              emoji,
              selected.start,
              selected.end,
            );
            if (next.value.length <= 4000) {
              setFormatError('');
              onDraft(next.value);
              setChoosingEmoji(false);
              requestAnimationFrame(() => {
                inputRef.current?.focus();
                inputRef.current?.setSelectionRange(next.cursor, next.cursor);
              });
            } else {
              setFormatError('The message limit is 4,000 characters.');
              setChoosingEmoji(false);
            }
          }}
        />
      )}
      {formatError && (
        <p role="alert" className="mb-1 px-2 text-xs text-destructive">
          {formatError}
        </p>
      )}
      {blocked && (
        <p role="status" className="mb-1 px-2 text-xs text-muted-foreground">
          {blockedReason}
          {blockedUntil && (
            <> Available after {new Date(blockedUntil).toLocaleTimeString()}.</>
          )}
        </p>
      )}
      {!blocked && attachmentsBlocked && (
        <p role="status" className="mb-1 px-2 text-xs text-muted-foreground">
          {attachmentsBlockedReason}
        </p>
      )}
      {voiceOpen && (
        <VoiceNoteComposer
          onAttach={(file, durationMs) =>
            onVoiceFile ? onVoiceFile(file, durationMs) : false
          }
          onClose={() => setRecording(false)}
          canStart={voiceAllowed}
          canAttach={voiceAllowed}
          captureRestricted={attachmentsBlocked}
          unavailableReason={voiceUnavailableReason}
        />
      )}
      <div className="mb-1 flex gap-0.5" aria-label="Message formatting">
        {(
          [
            ['bold', Bold],
            ['italic', Italic],
            ['code', Code],
            ['quote', Quote],
            ['spoiler', EyeOff],
          ] as const
        ).map(([kind, Icon]) => (
          <Button
            key={kind}
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={`Format ${kind}`}
            disabled={busy}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format(kind)}
          >
            <Icon size={14} />
          </Button>
        ))}
      </div>
      <div className="flex items-end gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="phone:size-11"
          type="button"
          aria-label="Insert emoji"
          disabled={busy || draft.length >= 4000}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            emojiSelection.current = {
              start: inputRef.current?.selectionStart ?? draft.length,
              end: inputRef.current?.selectionEnd ?? draft.length,
            };
            setChoosingEmoji(true);
          }}
        >
          <Smile size={17} />
        </Button>
        {!editing && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              disabled={!filesAllowed}
              className="sr-only"
              aria-label="Choose attachments"
              onChange={(event) => {
                if (filesAllowed) onFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="phone:size-11"
              type="button"
              disabled={!filesAllowed}
              aria-label="Attach files"
              title={`Attach up to ${maxAttachments} files, ${attachmentSize(maxFileBytes)} each`}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={17} />
            </Button>
            {onVoiceFile && (
              <Button
                variant="ghost"
                size="icon"
                className="phone:size-11"
                type="button"
                disabled={!voiceAllowed || voiceOpen}
                aria-label="Record voice note"
                onClick={() => setRecording(true)}
              >
                <Mic size={17} />
              </Button>
            )}
          </>
        )}
        <textarea
          ref={(node) => {
            inputRef.current = node;
            if (node) {
              node.style.height = 'auto';
              node.style.height = `${Math.min(144, Math.max(phone ? 44 : 48, node.scrollHeight))}px`;
            }
          }}
          rows={1}
          enterKeyHint={phone ? 'send' : undefined}
          maxLength={4000}
          className="min-w-0 flex-1 resize-none border-0! bg-transparent! px-2! py-2! text-sm shadow-none! outline-none phone:text-base"
          aria-label={`Message ${label}`}
          placeholder={
            phone ? 'Message…' : 'Write a message… Type @ to mention'
          }
          value={draft}
          disabled={busy}
          onBlur={onTypingStop}
          onPaste={(event) => {
            if (!editing && event.clipboardData.files.length) {
              event.preventDefault();
              if (filesAllowed) onFiles(event.clipboardData.files);
            }
          }}
          onChange={(event) => {
            setFormatError('');
            onDraft(event.target.value);
            onSuggestion(0);
          }}
          onKeyDown={(event) => {
            if (
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              event.nativeEvent.isComposing
            )
              return;
            if (
              suggested.length &&
              ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)
            ) {
              event.preventDefault();
              if (event.key === 'Enter')
                onMention(suggested[suggestion % suggested.length]);
              else
                onSuggestion(
                  (index) =>
                    (index +
                      (event.key === 'ArrowDown' ? 1 : suggested.length - 1)) %
                    suggested.length,
                );
            } else if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (!busy && !blocked && !voiceOpen) onSend();
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          type="submit"
          className="phone:size-11 phone:rounded-full phone:bg-primary phone:text-primary-foreground"
          disabled={
            (!draft.trim() && (editing || attachments.length === 0)) ||
            busy ||
            blocked ||
            voiceOpen
          }
          aria-label={
            uploading
              ? 'Uploading attachments'
              : editing
                ? 'Save message'
                : 'Send message'
          }
        >
          {editing ? <Check size={17} /> : <Send size={17} />}
        </Button>
      </div>
      {!editing && (
        <p className="px-2 pt-1 text-[0.65rem] text-muted-foreground">
          {uploading
            ? 'Uploading files. You can cancel an upload without losing this draft.'
            : attachments.length
              ? `${attachments.length} of ${maxAttachments} attachments · Nothing is sent until the message is delivered.`
              : `Drop files or paste an image · Up to ${attachmentSize(maxFileBytes)} per file`}
        </p>
      )}
      {!editing &&
        attachments.some((attachment) => !attachment.id) &&
        !uploading && (
          <p className="px-2 pt-1 text-[0.65rem] text-muted-foreground">
            Keep this conversation open until uploading finishes; file
            selections stay on this device.
          </p>
        )}
    </form>
  );
}
