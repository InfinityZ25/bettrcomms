import {
  api,
  ApiRequestError,
  type Message,
  type MessagePage,
  type RoomUnread,
  type User,
} from '@/api';

export type ConversationState = {
  messages: Message[];
  anchor?: Message;
  members: User[];
  before?: string;
  unreadBoundary?: number;
  loading: boolean;
  loadingOlder: boolean;
  error: string;
};
const emptyConversation: ConversationState = {
  messages: [],
  members: [],
  loading: false,
  loadingOlder: false,
  error: '',
};
const conversations = new Map<string, ConversationState>();
const subscribers = new Map<string, Set<() => void>>();
const pending = new Map<string, AbortController>();
const unreadListeners = new Set<() => void>();
const activityListeners = new Set<() => void>();
let unread: Record<string, RoomUnread> = {};
let activity: Record<string, string> = {};
let userId: string | undefined;
let generation = 0;
let unreadTimer: ReturnType<typeof setTimeout> | undefined;
let unreadRequest = 0;

export function mergeMessages(...groups: Message[][]) {
  const byId = new Map<string, Message>();
  for (const group of groups)
    for (const message of group) {
      const current = byId.get(message.id);
      if (!current || (message.version ?? 0) > (current.version ?? 0))
        byId.set(message.id, message);
    }
  // Reply previews follow edits/deletions even when the reply itself did not change.
  return [...byId.values()]
    .map((message) => {
      const parent = message.reply && byId.get(message.reply.id);
      return parent
        ? {
            ...message,
            reply: {
              id: parent.id,
              name: parent.author.name,
              body: parent.body.slice(0, 400),
              deleted: Boolean(parent.deleted_at),
            },
          }
        : message;
    })
    .sort(
      (a, b) =>
        (a.sequence ?? Date.parse(a.created_at)) -
          (b.sequence ?? Date.parse(b.created_at)) || a.id.localeCompare(b.id),
    );
}

export const conversationSnapshot = (room: string) =>
  conversations.get(room) ?? emptyConversation;
export function subscribeConversation(room: string, listener: () => void) {
  let listeners = subscribers.get(room);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(room, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) subscribers.delete(room);
  };
}
function put(room: string, patch: Partial<ConversationState>) {
  conversations.set(room, { ...conversationSnapshot(room), ...patch });
  // Keep at most twelve inactive histories; evicted rooms reload on demand.
  const inactive = [...conversations.keys()].filter(
    (id) => !subscribers.has(id),
  );
  for (const id of inactive.slice(0, Math.max(0, inactive.length - 12))) {
    pending.get(id)?.abort();
    pending.delete(id);
    conversations.delete(id);
  }
  for (const listener of subscribers.get(room) ?? []) listener();
}
export const unreadSnapshot = () => unread;
export const activitySnapshot = () => activity;
export function subscribeActivity(listener: () => void) {
  activityListeners.add(listener);
  return () => { activityListeners.delete(listener); };
}
export function subscribeUnread(listener: () => void) {
  unreadListeners.add(listener);
  return () => {
    unreadListeners.delete(listener);
  };
}
function putUnread(next: Record<string, RoomUnread>) {
  unread = next;
  for (const listener of unreadListeners) listener();
}

export async function refreshUnread() {
  if (!userId) return;
  const currentGeneration = generation;
  const request = ++unreadRequest;
  try {
    const result = await api<{ rooms: RoomUnread[] }>('/messages/unread');
    if (generation === currentGeneration && request === unreadRequest)
      putUnread(
        Object.fromEntries(result.rooms.map((room) => [room.room_id, room])),
      );
  } catch {
    /* Existing counts survive a temporary disconnect; reconnect reconciles. */
  }
}
function scheduleUnread() {
  if (unreadTimer !== undefined) return;
  unreadTimer = setTimeout(() => {
    unreadTimer = undefined;
    void refreshUnread();
  }, 80);
}

export function startMessagingSession(id: string) {
  generation += 1;
  userId = id;
  conversations.clear();
  reading.clear();
  putUnread({});
  activity = {};
  void refreshUnread();
  return () => {
    generation += 1;
    userId = undefined;
    for (const request of pending.values()) request.abort();
    pending.clear();
    conversations.clear();
    if (unreadTimer !== undefined) clearTimeout(unreadTimer);
    unreadTimer = undefined;
    putUnread({});
    activity = {};
    for (const listener of activityListeners) listener();
  };
}

export async function loadConversation(room: string, older = false) {
  if (!userId || pending.has(room)) return;
  const snapshot = conversationSnapshot(room);
  if (older && !snapshot.before) return;
  const controller = new AbortController();
  pending.set(room, controller);
  const currentGeneration = generation;
  put(room, {
    error: '',
    ...(older ? { loadingOlder: true } : { loading: true }),
  });
  try {
    const cursor = older
      ? `?before_id=${encodeURIComponent(snapshot.before!)}`
      : '';
    const [page, members] = await Promise.all([
      api<MessagePage>(
        `/rooms/${room}/messages${cursor}`,
        undefined,
        undefined,
        controller.signal,
      ),
      older || snapshot.members.length
        ? Promise.resolve(snapshot.members)
        : api<{ members: { user: User }[] }>(
            `/rooms/${room}/members`,
            undefined,
            undefined,
            controller.signal,
          ).then((result) => result.members.map((member) => member.user)),
    ]);
    if (generation !== currentGeneration || controller.signal.aborted) return;
    put(room, {
      messages: mergeMessages(
        conversationSnapshot(room).messages,
        page.messages,
      ),
      members,
      before:
        older || !snapshot.messages.length ? page.before_id : snapshot.before,
      unreadBoundary: older ? snapshot.unreadBoundary : (snapshot.unreadBoundary ?? page.read_sequence),
    });
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      [403, 404].includes(error.status) &&
      generation === currentGeneration
    )
      put(room, { messages: [], members: [], before: undefined });
    if (!controller.signal.aborted && generation === currentGeneration)
      put(room, {
        error:
          error instanceof Error ? error.message : 'Could not load messages',
      });
  } finally {
    if (pending.get(room) === controller) pending.delete(room);
    if (generation === currentGeneration && !controller.signal.aborted)
      put(room, { loading: false, loadingOlder: false });
  }
}

export function receiveMessage(id: string, message: Message) {
  if (id !== userId) return;
  if (!activity[message.room_id] || Date.parse(message.created_at) > Date.parse(activity[message.room_id])) {
    activity = { ...activity, [message.room_id]: message.created_at };
    for (const listener of activityListeners) listener();
  }
  // Only opened conversations retain history; the app's existing socket keeps
  // its bounded notification backlog independently.
  if (conversations.has(message.room_id)) {
    const state = conversationSnapshot(message.room_id);
    const first = state.messages[0]?.sequence ?? 0;
    const inRange =
      (message.sequence ?? 0) >= first ||
      state.messages.some((item) => item.id === message.id);
    put(message.room_id, {
      messages: mergeMessages(state.messages, [message]).filter(
        (item) => inRange || item.id !== message.id,
      ),
      anchor: state.anchor
        ? mergeMessages([state.anchor], state.messages, [message]).find(
            (item) => item.id === state.anchor?.id,
          )
        : undefined,
    });
  }
  scheduleUnread();
}
export function reconcileMessaging(id: string, reset = false) {
  if (id !== userId) return;
  void refreshUnread();
  for (const request of pending.values()) request.abort();
  pending.clear();
  if (reset) conversations.clear();
  else for (const room of conversations.keys()) if (!subscribers.has(room)) conversations.delete(room);
  for (const room of subscribers.keys()) {
    if (reset || !conversationSnapshot(room).messages.length) {
      put(room, { ...emptyConversation });
      void loadConversation(room);
    } else void catchUpConversation(room);
  }
}

async function catchUpConversation(room: string) {
  if (!userId || pending.has(room)) return;
  const first = conversationSnapshot(room).messages[0];
  if (!first?.sequence) { void loadConversation(room); return; }
  const currentGeneration = generation;
  const controller = new AbortController();
  pending.set(room, controller);
  try {
    // Reload the range already on screen as well as new messages. Edits,
    // reactions and deletions keep their original sequence.
    let cursor = first.sequence - 1;
    for (;;) {
      const page = await api<MessagePage>(`/rooms/${room}/messages?after_sequence=${cursor}&limit=100`, undefined, undefined, controller.signal);
      if (controller.signal.aborted || generation !== currentGeneration) return;
      if (!page.messages.length) break;
      put(room, { messages: mergeMessages(conversationSnapshot(room).messages, page.messages) });
      cursor = page.messages.at(-1)!.sequence ?? cursor;
      if (!page.before_id) break;
    }
    const anchor = conversationSnapshot(room).anchor;
    if (anchor && (anchor.sequence ?? 0) < first.sequence) {
      const result = await api<{ message: Message }>(`/rooms/${room}/messages/${anchor.id}`, undefined, undefined, controller.signal);
      if (!controller.signal.aborted && generation === currentGeneration)
        put(room, { anchor: result.message });
    }
  } catch (error) {
    if (!controller.signal.aborted && generation === currentGeneration)
      put(room, { error: error instanceof Error ? error.message : 'Could not reconcile messages' });
  } finally {
    if (pending.get(room) === controller) pending.delete(room);
  }
}
const reading = new Map<string, number>();
export async function markRead(room: string, message: Message) {
  const sequence = message.sequence ?? 0;
  if (
    !userId ||
    sequence <= (unread[room]?.read_sequence ?? 0) ||
    sequence <= (reading.get(room) ?? 0)
  )
    return;
  const currentGeneration = generation;
  reading.set(room, sequence);
  try {
    await api(`/rooms/${room}/read`, { message_id: message.id }, 'PUT');
    if (generation === currentGeneration) {
      if (conversations.has(room))
        put(room, { unreadBoundary: Math.max(conversationSnapshot(room).unreadBoundary ?? 0, sequence) });
      void refreshUnread();
    }
  } finally {
    if (reading.get(room) === sequence) reading.delete(room);
  }
}
export async function writeMessage(
  room: string,
  body: string,
  reply?: string,
  id?: string,
  attachmentIDs: string[] = [],
  nonce?: string,
) {
  const currentGeneration = generation;
  const result = await api<{ message: Message }>(
    `/rooms/${room}/messages${id ? `/${id}` : ''}`,
    { body, reply_to_id: reply, attachment_ids: attachmentIDs, client_nonce: nonce },
    id ? 'PATCH' : 'POST',
  );
  if (generation === currentGeneration && userId)
    receiveMessage(userId, result.message);
  return result.message;
}
export async function deleteMessage(room: string, id: string) {
  const currentGeneration = generation;
  const result = await api<{ message: Message }>(
    `/rooms/${room}/messages/${id}`,
    undefined,
    'DELETE',
  );
  if (generation === currentGeneration && userId)
    receiveMessage(userId, result.message);
}
export async function reactMessage(
  room: string,
  id: string,
  emoji: string,
  remove: boolean,
) {
  const currentGeneration = generation;
  const result = await api<{ message: Message }>(
    `/rooms/${room}/messages/${id}/reactions`,
    { emoji },
    remove ? 'DELETE' : 'PUT',
  );
  if (generation === currentGeneration && userId)
    receiveMessage(userId, result.message);
}
export async function jumpToMessage(room: string, id: string) {
  const currentGeneration = generation;
  const result = await api<{ message: Message }>(
    `/rooms/${room}/messages/${id}`,
  );
  if (generation !== currentGeneration) return;
  const state = conversationSnapshot(room);
  if (state.messages.some((message) => message.id === id)) {
    put(room, {
      messages: mergeMessages(state.messages, [result.message]),
      anchor: undefined,
    });
  } else {
    // A distant search hit is a separate preview, never a fake contiguous page.
    put(room, { anchor: result.message });
  }
  return result.message;
}
