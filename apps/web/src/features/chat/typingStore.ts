const scope = (room: string, root?: string) => root ? `${room}|${root}` : room;
const listeners = new Map<string, Set<() => void>>();
const active = new Map<string, Map<string, number>>();
const snapshots = new Map<string, string[]>();
let socket: WebSocket | null = null;
let socketUser: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

export function setTypingSocket(next: WebSocket | null, user?: string) {
  socket = next;
  socketUser = user;
  if (!next) clearTyping();
}

export function publishTyping(user: string, room: string, typing: boolean, root?: string) {
  if (socketUser !== user || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'chat.typing', payload: { room_id: room, typing, ...(root ? { thread_root_id: root } : {}) } }));
}

export function receiveTyping(room: string, user: string, typing: boolean, root?: string) {
  room = scope(room, root);
  let people = active.get(room);
  if (!people) { people = new Map(); active.set(room, people); }
  if (typing) people.set(user, Date.now() + 5500);
  else people.delete(user);
  emit(room);
  scheduleExpiry();
}

function emit(room: string) {
  snapshots.set(room, [...(active.get(room)?.keys() ?? [])]);
  for (const listener of listeners.get(room) ?? []) listener();
}

function scheduleExpiry() {
  if (timer !== undefined) clearTimeout(timer);
  let next = Infinity;
  for (const people of active.values()) for (const expiry of people.values()) next = Math.min(next, expiry);
  if (next === Infinity) return;
  timer = setTimeout(() => {
    timer = undefined;
    const now = Date.now();
    for (const [room, people] of active) {
      let changed = false;
      for (const [user, expiry] of people) if (expiry <= now) { people.delete(user); changed = true; }
      if (!people.size) active.delete(room);
      if (changed) emit(room);
    }
    scheduleExpiry();
  }, Math.max(1, next - Date.now()));
}

export function clearTyping() {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  for (const room of active.keys()) { active.delete(room); emit(room); }
}

export const typingSnapshot = (room: string, root?: string) => snapshots.get(scope(room, root)) ?? empty;
const empty: string[] = [];
export function subscribeTyping(room: string, listener: () => void, root?: string) {
  room = scope(room, root);
  let roomListeners = listeners.get(room);
  if (!roomListeners) { roomListeners = new Set(); listeners.set(room, roomListeners); }
  roomListeners.add(listener);
  return () => { roomListeners.delete(listener); if (!roomListeners.size) listeners.delete(room); };
}
