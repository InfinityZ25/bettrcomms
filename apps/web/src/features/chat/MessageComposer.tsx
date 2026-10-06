import { useRef, useState, type FormEvent, type RefObject, type Dispatch, type SetStateAction } from 'react';
import { AtSign, Bold, Check, Code, Italic, Mic, Paperclip, Quote, Send, X, EyeOff, Smile } from 'lucide-react';
import type { Message, User } from '@/api';
import type { PendingAttachment } from './drafts';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { formatMessagePreview, formatSelection, type FormatKind } from './messageFormatting';
import EmojiDialog from './EmojiDialog';
import { insertEmoji } from './emojiCatalog';
import VoiceNoteComposer from './VoiceNoteComposer';
import { voiceNoteTime } from './voiceNoteRecorder';
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
  blocked = false,
  blockedReason,
  blockedUntil,
  attachmentsBlocked = blocked,
  userId,
  recordingKey,
  onVoiceFile,
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
  blocked?: boolean;
  blockedReason?: string;
  blockedUntil?: string;
  attachmentsBlocked?: boolean;
  userId?: string;
  recordingKey?: string;
  onVoiceFile?: (file: File, durationMs: number) => boolean | void;
}) {
  const phone = useIsMobile();
  const fileInput = useRef<HTMLInputElement>(null);
  const [choosingEmoji, setChoosingEmoji] = useState(false);
  const [recording, setRecording] = useState(false);
  const [formatError, setFormatError] = useState('');
  const emojiSelection = useRef({ start: 0, end: 0 });
  const voiceAllowed = !editing && !blocked && !attachmentsBlocked && !busy && attachments.length < 4 && Boolean(onVoiceFile);
  const voiceOpen = recording && voiceAllowed;
  const format = (kind: FormatKind) => {
    const field = inputRef.current;
    const result = formatSelection(draft, field?.selectionStart ?? draft.length, field?.selectionEnd ?? draft.length, kind);
    if (result.value.length > 4000) { setFormatError('The message limit is 4,000 characters.'); return; }
    setFormatError('');
    onDraft(result.value);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(result.start, result.end); });
  };
  return (
    <form
      className="message-composer relative m-3 shrink-0 rounded-2xl border bg-muted/60 p-2 phone:m-2 phone:p-1 focus-within:ring-2 focus-within:ring-ring/40"
      onSubmit={(event) => { if (blocked || voiceOpen) event.preventDefault(); else onSend(event); }}
      onDragOver={(event) => { if (!editing) event.preventDefault(); }}
      onDrop={(event) => {
        if (editing) return;
        event.preventDefault();
        if (!busy && !attachmentsBlocked) onFiles(event.dataTransfer.files);
      }}
    >
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
              <span className="truncate">{attachment.voice_note ? `Voice note · ${voiceNoteTime(attachment.duration_ms ?? 0)}` : attachment.filename}</span>
              <button type="button" aria-label={`Remove ${attachment.filename}`} disabled={busy} onClick={() => onRemoveFile(index)}><X size={13} /></button>
            </span>
          ))}
        </div>
      )}
      {choosingEmoji && <EmojiDialog userId={userId} onClose={() => { setChoosingEmoji(false); inputRef.current?.focus(); }} onSelect={(emoji) => {
        const selected = emojiSelection.current;
        const next = insertEmoji(draft, emoji, selected.start, selected.end);
        if (next.value.length <= 4000) {
          setFormatError('');
          onDraft(next.value);
          setChoosingEmoji(false);
          requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(next.cursor, next.cursor); });
        } else { setFormatError('The message limit is 4,000 characters.'); setChoosingEmoji(false); }
      }} />}
      {formatError && <p role="alert" className="mb-1 px-2 text-xs text-destructive">{formatError}</p>}
      {blocked && <p role="status" className="mb-1 px-2 text-xs text-muted-foreground">{blockedReason}{blockedUntil && <> Available after {new Date(blockedUntil).toLocaleTimeString()}.</>}</p>}
      {voiceOpen && onVoiceFile && <VoiceNoteComposer key={recordingKey ?? userId} onAttach={onVoiceFile} onClose={() => setRecording(false)} />}
      <div className="mb-1 flex gap-0.5" aria-label="Message formatting">
        {([['bold', Bold], ['italic', Italic], ['code', Code], ['quote', Quote], ['spoiler', EyeOff]] as const).map(([kind, Icon]) => <Button key={kind} variant="ghost" size="icon-sm" type="button" aria-label={`Format ${kind}`} disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => format(kind)}><Icon size={14} /></Button>)}
      </div>
      <div className="flex items-end gap-1">
        <Button variant="ghost" size="icon" className="phone:size-11" type="button" aria-label="Insert emoji" disabled={busy || draft.length >= 4000} onMouseDown={(event) => event.preventDefault()} onClick={() => {
          emojiSelection.current = { start: inputRef.current?.selectionStart ?? draft.length, end: inputRef.current?.selectionEnd ?? draft.length };
          setChoosingEmoji(true);
        }}><Smile size={17} /></Button>
        {!editing && (
          <>
            <input ref={fileInput} type="file" multiple disabled={busy || attachmentsBlocked} className="sr-only" aria-label="Choose attachments" onChange={(event) => { if (!busy && !attachmentsBlocked) onFiles(event.target.files); event.target.value = ''; }} />
            <Button variant="ghost" size="icon" className="phone:size-11" type="button" disabled={busy || attachmentsBlocked || attachments.length >= 4} aria-label="Attach files" onClick={() => fileInput.current?.click()}><Paperclip size={17} /></Button>
            {onVoiceFile && <Button variant="ghost" size="icon" className="phone:size-11" type="button" disabled={!voiceAllowed || voiceOpen} aria-label="Record voice note" onClick={() => setRecording(true)}><Mic size={17} /></Button>}
          </>
        )}
        <textarea
          ref={(node) => {
            inputRef.current = node;
            if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(144, Math.max(phone ? 44 : 48, node.scrollHeight))}px`; }
          }}
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
              if (!attachmentsBlocked && !busy) onFiles(event.clipboardData.files);
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
              if (!blocked && !voiceOpen) onSend();
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          type="submit"
          className="phone:size-11 phone:rounded-full phone:bg-primary phone:text-primary-foreground"
          disabled={(!draft.trim() && (editing || attachments.length === 0)) || busy || blocked || voiceOpen}
          aria-label={editing ? 'Save message' : 'Send message'}
        >
          {editing ? <Check size={17} /> : <Send size={17} />}
        </Button>
      </div>
    </form>
  );
}
