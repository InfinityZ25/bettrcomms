import { useSyncExternalStore } from 'react';
import type { CallParticipant, Message, User } from '@/api';
import { receiveMessage, reconcileMessaging, refreshUnread } from '@/features/chat/messageStore';
import { apiSocketUrl } from '@/desktop/apiTransport';
import { receiveTyping, setTypingSocket } from '@/features/chat/typingStore';
import { useMountEffect } from '@/hooks/useMountEffect';
import { clearProfiles, receiveProfile } from '@/features/settings/profileStore';
import { clearAvatarCache } from '@/features/settings/avatarCache';
import { contactStatus, receiveOwnPresence, startPresenceSession, type ContactStatus } from '@/features/settings/presenceStore';

type RoomPresence = { room_id: string; participants: CallParticipant[] };
type RealtimeMessage = { sequence: number; value: Message };
type RealtimeState = {
  userId?: string; known: boolean; rooms: Record<string, CallParticipant[]>;
  roomsRevision: number; friendsRevision: number; syncRevision: number;
  onlineUsers: Record<string, boolean>; contactStatuses: Record<string, ContactStatus>;
  messages: RealtimeMessage[];
};
const emptyState: RealtimeState = {
  known: false, rooms: {}, roomsRevision: 0, friendsRevision: 0, syncRevision: 0,
  onlineUsers: {}, contactStatuses: {}, messages: [],
};
let state = emptyState;
let sessionGeneration = 0;
const listeners = new Set<() => void>();
export const callPresenceSnapshot = () => state;
export function subscribeCallPresence(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function update(patch: Partial<RealtimeState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/** Mount keyed by account ID. One socket serves calls, chats, profiles and presence. */
export function PresenceSession({ user }: { user: User }) {
  useMountEffect(() => startRealtimeSession(user));
  return null;
}
export function useCallPresence(userId?: string) {
  const current = useSyncExternalStore(subscribeCallPresence, callPresenceSnapshot, callPresenceSnapshot);
  return userId && current.userId === userId ? current : emptyState;
}
export function startRealtimeSession(user: User) {
  const userId = user.id;
  const session = ++sessionGeneration;
  const stopPresence = startPresenceSession(userId, user.presence_status);
  receiveProfile(user);
  update({ ...emptyState, userId });
  let stopped = false;
  let socket: WebSocket | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = 500;
  let messageSequence = 0;
  const active = () => !stopped && sessionGeneration === session;

  const connect = () => {
    if (!active()) return;
    let href: string;
    try { href = apiSocketUrl('/api/v1/events'); } catch { return; }
    const current = new WebSocket(href);
    socket = current;
    current.onopen = () => {
      if (!active() || socket !== current) return;
      reconnectDelay = 500;
      setTypingSocket(current, userId);
      const ping = () => {
        if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ping', request_id: crypto.randomUUID() }));
      };
      ping();
      pingTimer = setInterval(ping, 20_000);
    };
    current.onmessage = (event) => {
      if (!active() || socket !== current) return;
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; payload?: unknown };
        if (message.type === 'app.ready') {
          reconcileMessaging(userId);
          const payload = message.payload as {
            presence?: RoomPresence[]; online_user_ids?: string[];
            contact_presence?: { user_id: string; online: boolean; status: unknown }[];
            own_presence?: { status?: unknown };
          } | undefined;
          const onlineUsers = Object.fromEntries((payload?.online_user_ids ?? []).map((id) => [id, true]));
          const contactStatuses: Record<string, ContactStatus> = {};
          for (const person of payload?.contact_presence ?? []) {
            if (!person.user_id || typeof person.online !== 'boolean') continue;
            const status = contactStatus(person.status, person.online);
            onlineUsers[person.user_id] = status !== 'offline';
            contactStatuses[person.user_id] = status;
          }
          receiveOwnPresence(userId, payload?.own_presence?.status);
          update({
            known: true, rooms: Object.fromEntries((payload?.presence ?? []).map((room) => [room.room_id, room.participants])),
            onlineUsers, contactStatuses, syncRevision: state.syncRevision + 1,
          });
        } else if (message.type === 'call.presence') {
          const room = message.payload as RoomPresence;
          if (!room?.room_id || !Array.isArray(room.participants)) return;
          update({ known: true, rooms: { ...state.rooms, [room.room_id]: room.participants } });
        } else if (message.type === 'chat.updated' || message.type === 'chat.message') {
          const value = message.payload as Message;
          if (!value?.id || !value.room_id) return;
          receiveMessage(userId, value);
          if (message.type === 'chat.message') {
            messageSequence += 1;
            update({ messages: [...state.messages.slice(-99), { sequence: messageSequence, value }] });
          }
        } else if (message.type === 'chat.read') {
          void refreshUnread();
        } else if (message.type === 'chat.typing') {
          const value = message.payload as { room_id?: string; user_id?: string; typing?: boolean };
          if (value?.room_id && value.user_id && value.user_id !== userId && typeof value.typing === 'boolean') receiveTyping(value.room_id, value.user_id, value.typing);
        } else if (message.type === 'rooms.changed') {
          reconcileMessaging(userId, true);
          update({ roomsRevision: state.roomsRevision + 1 });
        } else if (message.type === 'friends.changed' || message.type === 'dm.requests.changed' || message.type === 'privacy.changed') {
          update({ friendsRevision: state.friendsRevision + 1 });
        } else if (message.type === 'user.profile') {
          const value = message.payload as { user?: User };
          if (!value?.user?.id || typeof value.user.name !== 'string') return;
          const profile = receiveProfile(value.user);
          if (!profile) return;
          const rooms = Object.fromEntries(Object.entries(state.rooms).map(([id, participants]) => [id, participants.map((person) => person.user_id === profile.id ? { ...person, name: profile.name } : person)]));
          update({ rooms, roomsRevision: state.roomsRevision + 1, friendsRevision: state.friendsRevision + 1 });
        } else if (message.type === 'user.presence') {
          const value = message.payload as { user_id?: string; online?: boolean; status?: unknown; desired_status?: unknown };
          if (!value?.user_id || typeof value.online !== 'boolean') return;
          if (value.user_id === userId) receiveOwnPresence(userId, value.desired_status);
          const status = contactStatus(value.status, value.online);
          update({ onlineUsers: { ...state.onlineUsers, [value.user_id]: status !== 'offline' }, contactStatuses: { ...state.contactStatuses, [value.user_id]: status } });
        }
      } catch { /* Isolate malformed events; the next event remains usable. */ }
    };
    current.onclose = () => {
      if (socket !== current) return;
      if (pingTimer !== undefined) clearInterval(pingTimer);
      pingTimer = undefined;
      socket = undefined;
      if (!active()) return;
      setTypingSocket(null);
      update({ known: false, onlineUsers: {}, contactStatuses: {} });
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(10_000, reconnectDelay * 2);
    };
  };
  connect();
  return () => {
    stopped = true;
    if (pingTimer !== undefined) clearInterval(pingTimer);
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close(1000, 'signed out or window closed');
    }
    stopPresence();
    if (sessionGeneration !== session) return;
    sessionGeneration += 1;
    setTypingSocket(null);
    clearProfiles();
    clearAvatarCache();
    update(emptyState);
  };
}
