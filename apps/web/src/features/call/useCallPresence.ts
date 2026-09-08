import { useEffect, useState } from 'react';
import type { CallParticipant } from '@/api';

/** Presence is ephemeral. A failed refresh must never look like an empty call. */
export function useCallPresence(userId?: string) {
  const [state, setState] = useState<{ userId?: string; known: boolean; rooms: Record<string, CallParticipant[]> }>({ known: false, rooms: {} });
  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    const refresh = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch('/api/v1/call-presence', { credentials: 'include', signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Presence unavailable');
        const data = await response.json() as { rooms: { room_id: string; participants: CallParticipant[] }[] };
        if (!stopped) setState({ userId, known: true, rooms: Object.fromEntries(data.rooms.map(room => [room.room_id, room.participants])) });
      } catch {
        if (!stopped) setState({ userId, known: false, rooms: {} });
      } finally {
        clearTimeout(timeout);
        if (!stopped) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => { stopped = true; controller?.abort(); clearTimeout(timer); };
  }, [userId]);
  return state.userId === userId && userId ? state : { known: false, rooms: {} as Record<string, CallParticipant[]> };
}
