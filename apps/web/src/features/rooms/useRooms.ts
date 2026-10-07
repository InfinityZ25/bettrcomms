import { useCallback, useEffect, useState, type SetStateAction } from 'react';
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
  const [{ rooms, room, fallbackRevision }, setState] = useState<{
    rooms: Room[];
    room: Room | null;
    fallbackRevision: number;
  }>({ rooms: [], room: null, fallbackRevision: 0 });

  const setRoom = useCallback((next: SetStateAction<Room | null>) => {
    setState((current) => ({
      ...current,
      room: typeof next === 'function' ? next(current.room) : next,
    }));
  }, []);

  const reload = useCallback(async () => {
    const result = await api<{ rooms: Room[] }>('/rooms');
    setState((current) => {
      const rooms = result.rooms ?? [];
      const selected = rooms.find((candidate) => candidate.id === current.room?.id);
      return {
        rooms,
        room: selected ?? rooms[0] ?? null,
        // Initial loading must preserve explicit section navigation. Losing an
        // existing selection instead hands navigation to its replacement.
        fallbackRevision: current.fallbackRevision + (current.room && !selected ? 1 : 0),
      };
    });
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
    setState((current) => ({
      ...current,
      room: next,
      rooms: current.rooms.some((candidate) => candidate.id === next.id)
        ? current.rooms
        : [next, ...current.rooms],
    }));
  }, []);

  const clear = useCallback(() => {
    setState((current) => ({ ...current, rooms: [], room: null }));
  }, []);

  return { rooms, room, fallbackRevision, setRoom, openRoom, reload, refresh, clear };
}
