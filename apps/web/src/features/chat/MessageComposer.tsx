import { useEffect, useRef, type FormEvent, type RefObject, type Dispatch, type SetStateAction } from 'react';
import { AtSign, Check, Paperclip, Send, X } from 'lucide-react';
import type { Message, User } from '@/api';
import type { PendingAttachment } from './drafts';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
export default function MessageComposer({
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
  onTypingStop,
}: {
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
  onTypingStop: () => void;
}) {
  const phone = useIsMobile();
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(144, Math.max(phone ? 44 : 48, input.scrollHeight))}px`;
  }, [draft, inputRef, phone]);
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="message-composer relative m-3 shrink-0 rounded-2xl border bg-muted/60 p-2 phone:m-2 phone:p-1 focus-within:ring-2 focus-within:ring-ring/40"
      onSubmit={onSend}
      onDragOver={(event) => { if (!editing) event.preventDefault(); }}
      onDrop={(event) => {
        if (editing) return;
        event.preventDefault();
        if (!busy) onFiles(event.dataTransfer.files);
      }}
    >
      {(editing || reply) && (
        <div className="mb-2 flex items-center gap-2 border-b pb-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            {editing
              ? 'Editing your message'
              : `Replying to ${reply?.author.name}: ${reply?.body}`}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label="Cancel reply or edit"
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
        <div className="mb-2 flex flex-wrap gap-1" aria-label="Files to attach">
          {attachments.map((attachment, index) => (
            <span key={attachment.id || attachment.localId} className="flex max-w-full items-center gap-1 rounded-lg border bg-background px-2 py-1 text-xs">
              <span className="truncate">{attachment.filename}</span>
              <button type="button" aria-label={`Remove ${attachment.filename}`} disabled={busy} onClick={() => onRemoveFile(index)}><X size={13} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1">
        {!editing && (
          <>
            <input ref={fileInput} type="file" multiple className="sr-only" aria-label="Choose attachments" onChange={(event) => { onFiles(event.target.files); event.target.value = ''; }} />
            <Button variant="ghost" size="icon" className="phone:size-11" type="button" disabled={busy || attachments.length >= 4} aria-label="Attach files" onClick={() => fileInput.current?.click()}><Paperclip size={17} /></Button>
          </>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          enterKeyHint={phone ? 'send' : undefined}
          maxLength={4000}
          className="min-w-0 flex-1 resize-none border-0! bg-transparent! px-2! py-2! text-sm shadow-none! outline-none phone:text-base"
          aria-label={`Message ${label}`}
          placeholder={phone ? 'Message…' : 'Write a message… Type @ to mention'}
          value={draft}
          disabled={busy}
          onBlur={onTypingStop}
          onPaste={(event) => {
            if (!editing && event.clipboardData.files.length) {
              event.preventDefault();
              onFiles(event.clipboardData.files);
            }
          }}
          onChange={(event) => {
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
              onSend();
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          type="submit"
          className="phone:size-11 phone:rounded-full phone:bg-primary phone:text-primary-foreground"
          disabled={(!draft.trim() && (editing || attachments.length === 0)) || busy}
          aria-label={editing ? 'Save message' : 'Send message'}
        >
          {editing ? <Check size={17} /> : <Send size={17} />}
        </Button>
      </div>
    </form>
  );
}
