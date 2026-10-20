import { useCallback, useSyncExternalStore } from 'react';
import { MessagesSquare, Users } from 'lucide-react';
import type { Room } from '@/api';
import { Avatar } from '@/components/avatar';
import { cn } from '@/lib/utils';
import { conversationSnapshot, subscribeConversation } from './messageStore';

type ConversationAvatarProps = {
  room: Room;
  /** Only the open conversation supplies a viewer; list icons stay unsubscribed. */
  viewerId?: string;
  className?: string;
};

/** A conversation is only a person's face when its cached membership proves it. */
export default function ConversationAvatar({
  room, viewerId, className,
}: ConversationAvatarProps) {
  if (room.kind === 'direct' && viewerId) {
    return <DirectAvatar room={room} viewerId={viewerId} className={className} />;
  }
  return <ConversationIcon group={room.kind === 'group'} className={className} />;
}

function DirectAvatar({
  room, viewerId, className,
}: ConversationAvatarProps & { viewerId: string }) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeConversation(room.id, listener),
    [room.id],
  );
  const snapshot = useCallback(() => {
    const { members } = conversationSnapshot(room.id);
    if (members.length !== 2 || !members.some((person) => person.id === viewerId)) {
      return undefined;
    }
    return members.find((person) => person.id !== viewerId);
  }, [room.id, viewerId]);
  const person = useSyncExternalStore(subscribe, snapshot, snapshot);
  return person ? (
    <Avatar
      id={person.id}
      name={person.name}
      src={person.avatar_url}
      character={person.character}
      className={className}
    />
  ) : <ConversationIcon className={className} />;
}

function ConversationIcon({
  group = false, className,
}: { group?: boolean; className?: string }) {
  const Icon = group ? Users : MessagesSquare;
  return (
    <span
      role="img"
      aria-label={group ? 'Group conversation' : 'Conversation'}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-xl',
        group ? 'bg-violet/15 text-violet' : 'bg-muted text-muted-foreground',
        className,
      )}
    >
      <Icon className="size-1/2" aria-hidden="true" />
    </span>
  );
}
