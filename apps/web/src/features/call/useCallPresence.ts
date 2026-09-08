import { useEffect, useState } from 'react';
import type { CallParticipant, Message } from '@/api';

type RoomPresence = { room_id: string; participants: CallParticipant[] };
type RealtimeMessage = { sequence: number; value: Message };

type RealtimeState = {
  userId?: string;
  known: boolean;
  rooms: Record<string, CallParticipant[]>;
  roomsRevision: number;
  friendsRevision: number;
  syncRevision: number;
  onlineUsers: Record<string, boolean>;
  messages: RealtimeMessage[];
};

const emptyState: RealtimeState = {
  known: false,
  rooms: {},
  roomsRevision: 0,
  friendsRevision: 0,
  syncRevision: 0,
  onlineUsers: {},
  messages: [],
};

/** One authenticated event stream keeps app-wide state current. */
export function useCallPresence(userId?: string) {
  const [state, setState] = useState<RealtimeState>(emptyState);

  useEffect(() => {
    if (!userId) {
      setState(emptyState);
      return;
    }

    let stopped = false;
    let socket: WebSocket | undefined;
    let pingTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let reconnectDelay = 500;
    let messageSequence = 0;

    setState({ ...emptyState, userId });

    const connect = () => {
      if (stopped) return;
      const url = new URL('/api/v1/events', window.location.href);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return;

      const current = new WebSocket(url.href);
      socket = current;
      current.onopen = () => {
        if (stopped || socket !== current) return;
        reconnectDelay = 500;
        const ping = () => {
          if (current.readyState === WebSocket.OPEN)
            current.send(JSON.stringify({ type: 'ping', request_id: crypto.randomUUID() }));
        };
        ping();
        pingTimer = window.setInterval(ping, 20_000);
      };
      current.onmessage = (event) => {
        if (stopped || socket !== current) return;
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; payload?: unknown };
          if (message.type === 'app.ready') {
            const payload = message.payload as { presence?: RoomPresence[]; online_user_ids?: string[] } | undefined;
            const rooms = Object.fromEntries(
              (payload?.presence ?? []).map((room) => [room.room_id, room.participants]),
            );
            setState((currentState) => ({
              ...currentState,
              userId,
              known: true,
              rooms,
              onlineUsers: Object.fromEntries((payload?.online_user_ids ?? []).map((id) => [id, true])),
              syncRevision: currentState.syncRevision + 1,
            }));
          } else if (message.type === 'call.presence') {
            const room = message.payload as RoomPresence;
            if (!room?.room_id || !Array.isArray(room.participants)) return;
            setState((currentState) => ({
              ...currentState,
              known: true,
              rooms: { ...currentState.rooms, [room.room_id]: room.participants },
            }));
          } else if (message.type === 'chat.message') {
            const value = message.payload as Message;
            if (!value?.id || !value.room_id) return;
            messageSequence += 1;
            setState((currentState) => ({
              ...currentState,
              messages: [
                ...currentState.messages.slice(-99),
                { sequence: messageSequence, value },
              ],
            }));
          } else if (message.type === 'rooms.changed') {
            setState((currentState) => ({
              ...currentState,
              roomsRevision: currentState.roomsRevision + 1,
            }));
          } else if (message.type === 'friends.changed') {
            setState((currentState) => ({
              ...currentState,
              friendsRevision: currentState.friendsRevision + 1,
            }));
          } else if (message.type === 'user.presence') {
            const value = message.payload as { user_id?: string; online?: boolean };
            if (!value.user_id || typeof value.online !== 'boolean') return;
            setState((currentState) => ({
              ...currentState,
              onlineUsers: { ...currentState.onlineUsers, [value.user_id!]: value.online! },
            }));
          }
        } catch {
          // A malformed event is isolated; the next event remains usable.
        }
      };
      current.onclose = () => {
        if (socket !== current) return;
        if (pingTimer !== undefined) window.clearInterval(pingTimer);
        pingTimer = undefined;
        socket = undefined;
        if (stopped) return;
        setState((currentState) => ({ ...currentState, known: false }));
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(10_000, reconnectDelay * 2);
      };
    };

    connect();
    return () => {
      stopped = true;
      if (pingTimer !== undefined) window.clearInterval(pingTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close(1000, 'signed out or window closed');
    };
  }, [userId]);

  return state.userId === userId && userId ? state : { ...emptyState };
}
