import type { FormEvent, RefObject } from 'react';
import { MessageSquare, Send, X } from 'lucide-react';
import { Avatar } from '@/components/avatar';
import type { Message } from '@/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { motion } from 'motion/react';
import { softSpring } from '@/lib/motion';

const time = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The room conversation: a drawer on narrow screens, a column on wide ones. */
export default function ChatPanel({
  messages,
  endRef,
  draft,
  onDraftChange,
  onSubmit,
  onClose,
  canSend,
  busy,
  hidden,
}: {
  messages: Message[];
  endRef: RefObject<HTMLDivElement | null>;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  canSend: boolean;
  busy: boolean;
  hidden: boolean;
}) {
  return (
    <motion.aside
      initial={{ opacity: 0, x: 28, scale: 0.985 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 22, scale: 0.985 }}
      transition={softSpring}
      className={cn(
        'absolute top-[70px] right-0 bottom-0 z-10 m-2 flex w-[calc(100vw-68px)] shrink-0 flex-col overflow-hidden rounded-2xl border bg-card/95 shadow-[-20px_0_50px_rgb(0_0_0/0.2)] backdrop-blur-xl min-[481px]:w-[300px] min-[821px]:static min-[821px]:my-2 min-[821px]:ml-0 min-[821px]:w-[250px] min-[821px]:shadow-sm min-[1251px]:w-[280px] min-[1400px]:w-[320px]',
        hidden && 'hidden',
      )}
    >
      <div className="flex items-center justify-between px-5 pt-6 pb-5">
        <strong className="text-sm font-semibold">Room chat</strong>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onClose}
          aria-label="Close chat"
        >
          <X size={17} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {!messages.length ? (
          <EmptyConversation />
        ) : (
          messages.map((message) => (
            <div className="mb-5 flex gap-2.5" key={message.id}>
              <Avatar name={message.author.name} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <strong className="text-xs">{message.author.name}</strong>
                  <time className="text-[0.6rem] text-muted-foreground">
                    {time(message.created_at)}
                  </time>
                </div>
                <p className="mt-1 [overflow-wrap:anywhere] whitespace-pre-wrap text-sm leading-6 text-foreground/80">
                  {message.body}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
      <form
        className="mx-4 mt-2.5 flex items-center rounded-xl border bg-muted pr-3 focus-within:ring-2 focus-within:ring-ring/40"
        onSubmit={onSubmit}
      >
        <Input
          className="min-w-0 border-0 bg-transparent px-3 py-3.5 text-xs shadow-none focus-visible:ring-0"
          placeholder={canSend ? 'Message your room…' : 'Sign in to say hello'}
          aria-label="Message your room"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          disabled={!canSend}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-primary"
          aria-label="Send message"
          disabled={!draft.trim() || busy}
        >
          <Send size={17} />
        </Button>
      </form>
      <span className="px-2 py-3 text-center text-[0.6rem] text-muted-foreground">
        A little less distance. A little more us.
      </span>
    </motion.aside>
  );
}

function EmptyConversation() {
  return (
    <div className="mt-4">
      <span className="grid size-12 place-items-center rounded-xl border bg-muted text-muted-foreground">
        <MessageSquare size={24} />
      </span>
      <h3 className="mt-5 max-w-44 font-heading text-base leading-6 font-semibold">
        The conversation starts here.
      </h3>
      <p className="mt-2.5 text-xs leading-6 text-muted-foreground">
        A link, a thought, a very important meme.
        <br />
        Drop it in.
      </p>
      <span className="my-8 flex items-center gap-2 text-[0.6rem] tracking-widest text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
        TODAY
      </span>
    </div>
  );
}
