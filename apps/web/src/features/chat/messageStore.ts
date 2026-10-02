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
  root?: Message;
  pins?: Message[];
  pinUpdates?: Record<string, Message>;
  threads?: Message[];
  threadBefore?: string;
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
const listPending = new Map<string, AbortController>();
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

export const conversationKey = (room: string, root?: string) => root ? `${room}|${root}` : room;
const scopeParts = (key: string) => { const [room, root] = key.split('|'); return { room, root }; };
const messagePath = (room: string, root?: string) => root ? `/rooms/${room}/threads/${root}/messages` : `/rooms/${room}/messages`;
export const conversationSnapshot = (room: string, root?: string) =>
  conversations.get(conversationKey(room, root)) ?? emptyConversation;
export function subscribeConversation(room: string, listener: () => void, root?: string) {
  room = conversationKey(room, root);
  let listeners = subscribers.get(room);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(room, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      subscribers.delete(room);
      pending.get(room)?.abort();
      pending.delete(room);
      const scope = scopeParts(room);
      if (!scope.root) for (const suffix of ['#pins', '#threads']) {
        listPending.get(scope.room + suffix)?.abort();
        listPending.delete(scope.room + suffix);
      }
      const state = conversations.get(room);
      if (state?.loading || state?.loadingOlder) put(room, { loading: false, loadingOlder: false });
    }
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
    for (const request of listPending.values()) request.abort();
    listPending.clear();
    conversations.clear();
    if (unreadTimer !== undefined) clearTimeout(unreadTimer);
    unreadTimer = undefined;
    putUnread({});
    activity = {};
    for (const listener of activityListeners) listener();
  };
}

export async function loadConversation(roomId: string, older = false, root?: string) {
  const room = conversationKey(roomId, root);
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
        messagePath(roomId, root) + cursor,
        undefined,
        undefined,
        controller.signal,
      ),
      older || snapshot.members.length
        ? Promise.resolve(snapshot.members)
        : api<{ members: { user: User }[] }>(
            `/rooms/${roomId}/members`,
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
      root: (conversationSnapshot(room).root?.version ?? 0) > (page.root?.version ?? 0) ? conversationSnapshot(room).root : page.root,
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
  const key = conversationKey(message.room_id, message.thread_root_id);
  if (conversations.has(key)) {
    const state = conversationSnapshot(key);
    const first = state.messages[0]?.sequence ?? 0;
    const inRange = (message.sequence ?? 0) >= first || state.messages.some((item) => item.id === message.id);
    put(key, {
      messages: mergeMessages(state.messages, [message]).filter((item) => inRange || item.id !== message.id),
      anchor: state.anchor ? mergeMessages([state.anchor], state.messages, [message]).find((item) => item.id === state.anchor?.id) : undefined,
    });
  }
  // Root edits/deletion/counts arrive as normal chat.updated events.
  const threadKey = conversationKey(message.room_id, message.id);
  const thread = conversations.get(threadKey);
  if (thread && (message.version ?? 0) >= (thread.root?.version ?? 0)) put(threadKey, { root: message });
  const main = conversations.get(message.room_id);
  if (main?.threads && !message.thread_root_id) {
    const known = main.threads.some((item) => item.id === message.id);
    put(message.room_id, { threads: !known && message.thread_reply_count ? [message, ...main.threads] : main.threads.map((item) => item.id === message.id && (message.version ?? 0) >= (item.version ?? 0) ? { ...message, thread_unread_count: item.thread_unread_count } : item) });
  }
  if (main?.pins) {
    const update = main.pinUpdates?.[message.id];
    if (update && (update.version ?? 0) > (message.version ?? 0)) { scheduleUnread(); return; }
    const pinUpdates = { ...main.pinUpdates, [message.id]: message };
    for (const id of Object.keys(pinUpdates).slice(0, Math.max(0, Object.keys(pinUpdates).length - 100))) delete pinUpdates[id];
    const pins = mergeMessages(main.pins, message.pinned_at && !message.deleted_at ? [message] : [])
      .filter((item) => item.id !== message.id || Boolean(message.pinned_at && !message.deleted_at))
      .sort((a, b) => Date.parse(b.pinned_at ?? '') - Date.parse(a.pinned_at ?? ''));
    put(message.room_id, { pins, pinUpdates });
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
      void loadConversation(scopeParts(room).room, false, scopeParts(room).root);
    } else void catchUpConversation(room);
    const scope = scopeParts(room);
    if (!scope.root && conversationSnapshot(room).pins) void loadPins(scope.room).catch(() => {});
    if (!scope.root && conversationSnapshot(room).threads) void loadThreads(scope.room).catch(() => {});
  }
}

async function catchUpConversation(room: string) {
  if (!userId || pending.has(room)) return;
  const first = conversationSnapshot(room).messages[0];
  if (!first?.sequence) { void loadConversation(scopeParts(room).room, false, scopeParts(room).root); return; }
  const currentGeneration = generation;
  const controller = new AbortController();
  pending.set(room, controller);
  try {
    // Reload the range already on screen as well as new messages. Edits,
    // reactions and deletions keep their original sequence.
    let cursor = first.sequence - 1;
    for (;;) {
      const page = await api<MessagePage>(messagePath(scopeParts(room).room, scopeParts(room).root) + `?after_sequence=${cursor}&limit=100`, undefined, undefined, controller.signal);
      if (controller.signal.aborted || generation !== currentGeneration) return;
      if (!page.messages.length) break;
      put(room, { messages: mergeMessages(conversationSnapshot(room).messages, page.messages), root: page.root });
      cursor = page.messages.at(-1)!.sequence ?? cursor;
      if (!page.before_id) break;
    }
    const { room: roomId } = scopeParts(room);
    const anchor = conversationSnapshot(room).anchor;
    if (anchor && (anchor.sequence ?? 0) < first.sequence) {
      const result = await api<{ message: Message }>(`/rooms/${roomId}/messages/${anchor.id}`, undefined, undefined, controller.signal);
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
export async function markRead(roomId: string, message: Message, root?: string) {
  const room = conversationKey(roomId, root);
  const sequence = message.sequence ?? 0;
  if (
    !userId ||
    sequence <= (root ? conversationSnapshot(room).unreadBoundary ?? 0 : unread[roomId]?.read_sequence ?? 0) ||
    sequence <= (reading.get(room) ?? 0)
  )
    return;
  const currentGeneration = generation;
  reading.set(room, sequence);
  try {
    await api(root ? `/rooms/${roomId}/threads/${root}/read` : `/rooms/${roomId}/read`, { message_id: message.id }, 'PUT');
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
  root?: string,
) {
  const currentGeneration = generation;
  const result = await api<{ message: Message }>(
    `/rooms/${room}/messages${id ? `/${id}` : ''}`,
    { body, reply_to_id: reply, attachment_ids: attachmentIDs, client_nonce: nonce, ...(root && !id ? { thread_root_id: root } : {}) },
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
export async function jumpToMessage(roomId: string, id: string, root?: string) {
  const room = conversationKey(roomId, root);
  const currentGeneration = generation;
  const result = await api<{ message: Message }>(
    `/rooms/${roomId}/messages/${id}`,
  );
  if (generation !== currentGeneration) return;
  if ((result.message.thread_root_id ?? undefined) !== root) return result.message;
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

export async function loadPins(room: string) {
  const revision = generation;
  const key = `${room}#pins`;
  listPending.get(key)?.abort();
  const controller = new AbortController(); listPending.set(key, controller);
  if (!conversationSnapshot(room).pins) put(room, { pins: [], pinUpdates: {} });
  try {
    const result = await api<{ messages: Message[] }>(`/rooms/${room}/pins`, undefined, undefined, controller.signal);
    if (revision !== generation || controller.signal.aborted) return;
    const updates = conversationSnapshot(room).pinUpdates ?? {};
    const byId = new Map(result.messages.map((item) => [item.id, item]));
    for (const update of Object.values(updates)) if ((update.version ?? 0) >= (byId.get(update.id)?.version ?? 0)) byId.set(update.id, update);
    put(room, { pins: [...byId.values()].filter((item) => item.pinned_at && !item.deleted_at).sort((a, b) => Date.parse(b.pinned_at!) - Date.parse(a.pinned_at!)) });
  } finally { if (listPending.get(key) === controller) listPending.delete(key); }
}
export async function loadThreads(room: string, older = false) {
  const revision = generation;
  const key = `${room}#threads`;
  listPending.get(key)?.abort();
  const controller = new AbortController(); listPending.set(key, controller);
  const previous = conversationSnapshot(room);
  try {
    const cursor = older && previous.threadBefore ? `?before_id=${encodeURIComponent(previous.threadBefore)}` : '';
    const result = await api<MessagePage>(`/rooms/${room}/threads${cursor}`, undefined, undefined, controller.signal);
    if (revision === generation && !controller.signal.aborted) put(room, { threads: older ? [...(previous.threads ?? []), ...result.messages] : result.messages, threadBefore: result.before_id });
  } finally { if (listPending.get(key) === controller) listPending.delete(key); }
}
export async function pinMessage(room: string, id: string, remove: boolean) {
  const revision = generation;
  const result = await api<{ message: Message }>(`/rooms/${room}/messages/${id}/pin`, undefined, remove ? 'DELETE' : 'PUT');
  if (revision === generation && userId) receiveMessage(userId, result.message);
}
