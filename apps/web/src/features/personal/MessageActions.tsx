import { useState, useSyncExternalStore } from 'react';
import { Bell, Bookmark, BookmarkCheck } from 'lucide-react';
import type { Message } from '@/api';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import {
  personalSnapshot,
  subscribePersonal,
  toggleSaved,
} from './personalStore';
import ReminderPicker from './ReminderPicker';

export function PersonalMessageActions({
  message,
  userId,
  menu = false,
  onError,
  onRemind,
}: {
  message: Message;
  userId: string;
  menu?: boolean;
  onError: (error: string) => void;
  onRemind?: () => void;
}) {
  const state = useSyncExternalStore(subscribePersonal, personalSnapshot);
  const [busy, setBusy] = useState(false);
  const [reminding, setReminding] = useState(false);
  const lifetime = useLifetimeSignal();
  const current = state.userId === userId;
  const saved = current && state.savedMessages.has(message.id);
  const reminder = current
    ? state.reminders.find((item) => item.message.id === message.id)
    : undefined;
  const Icon = saved ? BookmarkCheck : Bookmark;
  async function save() {
    if (busy) return;
    const signal = lifetime();
    setBusy(true);
    try {
      await toggleSaved('message', message.id);
    } catch (error) {
      if (!signal.aborted)
        onError(
          error instanceof Error ? error.message : 'Could not save message.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      {menu ? (
        <>
          <DropdownMenuItem
            disabled={!current || busy}
            onClick={() => void save()}
          >
            <Icon />
            {saved ? 'Remove saved message' : 'Save message'}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!current}
            onClick={() => {
              if (onRemind) onRemind();
              else setReminding(true);
            }}
          >
            <Bell />
            {reminder ? 'Reschedule reminder' : 'Remind me to reply'}
          </DropdownMenuItem>
        </>
      ) : (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!current || busy}
            aria-label={saved ? 'Remove saved message' : 'Save to personal inbox'}
            aria-pressed={saved}
            onClick={() => void save()}
          >
            <Icon size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!current}
            aria-label={reminder ? 'Reschedule reminder' : 'Remind me to reply'}
            onClick={() => setReminding(true)}
          >
            <Bell size={14} />
          </Button>
        </>
      )}
      {reminding && (
        <ReminderPicker
          roomId={message.room_id}
          messageId={message.id}
          existing={reminder?.due_at}
          onClose={() => setReminding(false)}
        />
      )}
    </>
  );
}
export function MessageReminderDialog({
  message,
  onClose,
}: {
  message: Message;
  onClose: () => void;
}) {
  const state = useSyncExternalStore(subscribePersonal, personalSnapshot);
  const reminder = state.reminders.find(
    (item) => item.message.id === message.id,
  );
  return (
    <ReminderPicker
      roomId={message.room_id}
      messageId={message.id}
      existing={reminder?.due_at}
      onClose={onClose}
    />
  );
}
export function SaveFileButton({
  attachmentId,
  filename,
  onError,
}: {
  attachmentId: string;
  filename: string;
  onError: (error: string) => void;
}) {
  const state = useSyncExternalStore(subscribePersonal, personalSnapshot);
  const [busy, setBusy] = useState(false);
  const lifetime = useLifetimeSignal();
  const saved = state.savedFiles.has(attachmentId);
  async function save() {
    if (busy) return;
    const signal = lifetime();
    setBusy(true);
    try {
      await toggleSaved('file', attachmentId);
    } catch (error) {
      if (!signal.aborted)
        onError(
          error instanceof Error ? error.message : 'Could not save file.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="min-h-11 self-start"
      disabled={!state.userId || busy}
      aria-label={`${saved ? 'Remove saved file' : 'Save file'} ${filename}`}
      aria-pressed={saved}
      onClick={() => void save()}
    >
      {saved ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
      {saved ? 'Saved' : 'Save file'}
    </Button>
  );
}
