import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Message, type Room } from '@/api';
import { errorMessage } from '@/lib/errors';

/** History and realtime deliveries overlap; the newest copy of each id wins. */
export const mergeMessages = (...groups: Message[][]) => {
  const byId = new Map<string, Message>();
  for (const group of groups) for (const message of group) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) =>
      new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
  );
};

export function useRoomMessages({
  room,
  revision,
  incoming,
  onError,
}: {
  room: Room | null;
  revision: number;
  incoming: Message[];
  onError: (message: string) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    if (!room) return;
    let active = true;
    api<{ messages: Message[] }>('/rooms/' + room.id + '/messages')
      .then((result) => {
        if (active)
          setMessages((current) => mergeMessages(result.messages ?? [], current));
      })
      .catch((error) => {
        if (active) onError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [room?.id, revision, onError]);

  useEffect(() => {
    const forThisRoom = incoming.filter((message) => message.room_id === room?.id);
    if (forThisRoom.length)
      setMessages((current) => mergeMessages(current, forThisRoom));
  }, [incoming, room?.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const append = useCallback(
    (message: Message) => setMessages((current) => mergeMessages(current, [message])),
    [],
  );

  return { messages, append, endRef };
}
