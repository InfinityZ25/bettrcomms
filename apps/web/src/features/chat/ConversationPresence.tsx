import { useSyncExternalStore } from 'react';
import type { User } from '@/api';
import { Companion } from '@/components/companion';
import {
  characterGesturesSnapshot,
  subscribeCharacterGestures,
  type CharacterGestureKind,
} from './characterGestureStore';

const gestureText: Record<CharacterGestureKind, string> = {
  wave: 'waves', nod: 'nods', celebrate: 'celebrates',
};

/** One reserved line for live, explicitly shared activity; never a message. */
export default function ConversationPresence({ roomId, threadRootId, typingPeople }: {
  roomId: string;
  threadRootId?: string;
  typingPeople: User[];
}) {
  const gestures = useSyncExternalStore(
    (listener) => subscribeCharacterGestures(roomId, listener, threadRootId),
    () => characterGesturesSnapshot(roomId, threadRootId),
  );
  const visibleTyping = typingPeople.slice(0, 3);
  const extraTyping = typingPeople.length - visibleTyping.length;
  const typingText = visibleTyping.map(({ name }) => name).join(', ') +
    (extraTyping ? ` and ${extraTyping} ${extraTyping === 1 ? 'other' : 'others'}` : '');
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-3 overflow-hidden px-5 text-xs text-muted-foreground phone:px-3" role="group" aria-label="Live conversation activity">
      {gestures.length ? (
        <div className="flex min-w-0 items-center gap-3" role="status">
          {gestures.map((event) => (
            <span key={event.id} className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden="true" className="shrink-0">
                <Companion userId={event.user_id} name={event.name} character={event.character} gesture={{ id: event.id, kind: event.gesture }} className="size-8" />
              </span>
              <span className="truncate">{event.name} {gestureText[event.gesture]}</span>
            </span>
          ))}
        </div>
      ) : visibleTyping.length ? (
        <div className="flex min-w-0 items-center gap-2" role="status">
          <span className="flex shrink-0 items-center gap-0" aria-hidden="true">
            {visibleTyping.map((person) => <Companion key={person.id} userId={person.id} name={person.name} character={person.character} className="size-7 rounded-full bg-background" />)}
          </span>
          <span className="truncate">{typingText} {typingPeople.length === 1 ? 'is' : 'are'} typing…</span>
        </div>
      ) : null}
    </div>
  );
}
