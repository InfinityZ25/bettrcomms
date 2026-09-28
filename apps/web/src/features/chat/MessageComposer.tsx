import type { FormEvent, RefObject, Dispatch, SetStateAction } from 'react';
import { AtSign, Check, Send, X } from 'lucide-react';
import type { Message, User } from '@/api';
import { Button } from '@/components/ui/button';
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
}) {
  return (
    <form
      className="relative m-3 rounded-2xl border bg-muted/60 p-2 focus-within:ring-2 focus-within:ring-ring/40"
      onSubmit={onSend}
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
      <div className="flex items-end gap-1">
        <textarea
          ref={inputRef}
          rows={2}
          maxLength={4000}
          className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none"
          aria-label={`Message ${label}`}
          placeholder="Write a message… Type @ to mention"
          value={draft}
          disabled={busy}
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
          disabled={!draft.trim() || busy}
          aria-label={editing ? 'Save message' : 'Send message'}
        >
          {editing ? <Check size={17} /> : <Send size={17} />}
        </Button>
      </div>
    </form>
  );
}
