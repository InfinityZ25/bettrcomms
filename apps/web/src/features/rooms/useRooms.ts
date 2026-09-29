import { useCallback, useEffect, useState } from 'react';
import { api, type Room, type User } from '@/api';
import { errorMessage } from '@/lib/errors';

/**
 * The room list and the room currently on screen. Reloads follow the signed-in
 * user and every realtime revision that can change membership, keeping the
 * selected room selected when it survives the refresh.
 */
export function useRooms(
  user: User | null,
  revision: number,
  onError: (message: string) => void,
) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [room, setRoom] = useState<Room | null>(null);

  const reload = useCallback(async () => {
    const result = await api<{ rooms: Room[] }>('/rooms');
    setRooms(result.rooms ?? []);
    setRoom(
      (current) =>
        result.rooms?.find((candidate) => candidate.id === current?.id) ??
        result.rooms?.[0] ??
        null,
    );
  }, []);

  const refresh = useCallback(
    () => void reload().catch((error) => onError(errorMessage(error))),
    [reload, onError],
  );

  useEffect(() => {
    if (user) refresh();
  }, [user?.id, revision, refresh]);

  /** Opens a room the list may not carry yet, such as a new direct conversation. */
  const openRoom = useCallback((next: Room) => {
    setRoom(next);
    setRooms((list) =>
      list.some((candidate) => candidate.id === next.id) ? list : [next, ...list],
    );
  }, []);

  const clear = useCallback(() => {
    setRooms([]);
    setRoom(null);
  }, []);

  return { rooms, room, setRoom, openRoom, reload, refresh, clear };
}
