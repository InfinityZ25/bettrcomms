import {
  api,
  subscribePersonalEvents,
  type MessageReminder,
  type SavedKind,
} from './api';

type PersonalState = {
  userId?: string;
  savedMessages: ReadonlySet<string>;
  savedFiles: ReadonlySet<string>;
  reminders: MessageReminder[];
  ready: boolean;
  revision: number;
  error: string;
};
const empty: PersonalState = {
  savedMessages: new Set(),
  savedFiles: new Set(),
  reminders: [],
  ready: false,
  revision: 0,
  error: '',
};
let state = empty;
let generation = 0;
let request: AbortController | undefined;
let reloadPending = false;
const listeners = new Set<() => void>();
export const personalSnapshot = () => state;
export function subscribePersonal(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function update(patch: Partial<PersonalState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export async function refreshPersonal() {
  if (!state.userId) return;
  if (request) {
    reloadPending = true;
    return;
  }
  const session = generation;
  const controller = new AbortController();
  request = controller;
  try {
    const [index, result] = await Promise.all([
      api<{ message_ids: string[]; file_ids: string[] }>(
        '/me/saved-items?index=1',
        undefined,
        undefined,
        controller.signal,
      ),
      api<{ reminders: MessageReminder[] }>(
        '/me/message-reminders?state=active&limit=100',
        undefined,
        undefined,
        controller.signal,
      ),
    ]);
    if (session !== generation || controller.signal.aborted) return;
    update({
      savedMessages: new Set(index.message_ids),
      savedFiles: new Set(index.file_ids),
      reminders: result.reminders,
      ready: true,
      error: '',
      revision: state.revision + 1,
    });
  } catch (error) {
    if (session === generation && !controller.signal.aborted)
      update({
        error:
          error instanceof Error
            ? error.message
            : 'Could not update your personal inbox.',
      });
  } finally {
    if (request === controller) request = undefined;
    if (session === generation && reloadPending) {
      reloadPending = false;
      void refreshPersonal();
    }
  }
}
export function startPersonalSession(userId: string) {
  request?.abort();
  request = undefined;
  reloadPending = false;
  const session = ++generation;
  update({ ...empty, userId });
  const off = subscribePersonalEvents((type) => {
    if (
      type === 'personal.saved.changed' ||
      type === 'personal.reminders.changed'
    )
      void refreshPersonal();
  });
  const focus = () => {
    void refreshPersonal();
  };
  window.addEventListener('focus', focus);
  const timer = setInterval(focus, 60000);
  void refreshPersonal();
  return () => {
    off();
    window.removeEventListener('focus', focus);
    clearInterval(timer);
    if (session !== generation) return;
    generation++;
    request?.abort();
    request = undefined;
    reloadPending = false;
    update(empty);
  };
}
export async function toggleSaved(kind: SavedKind, id: string) {
  if (!state.userId) throw new Error('Sign in to save items.');
  const session = generation;
  const collection =
    kind === 'message' ? state.savedMessages : state.savedFiles;
  const removing = collection.has(id);
  await api(
    `/me/saved-items/${kind}/${id}`,
    undefined,
    removing ? 'DELETE' : 'PUT',
  );
  if (session !== generation) return;
  const next = new Set(
    kind === 'message' ? state.savedMessages : state.savedFiles,
  );
  if (removing) next.delete(id);
  else next.add(id);
  update(
    kind === 'message'
      ? { savedMessages: next, revision: state.revision + 1 }
      : { savedFiles: next, revision: state.revision + 1 },
  );
}
export async function setMessageReminder(
  room: string,
  message: string,
  due: Date,
  mutation = crypto.randomUUID(),
) {
  await api(
    `/rooms/${room}/messages/${message}/reminder`,
    { due_at: due.toISOString(), mutation_id: mutation },
    'PUT',
  );
  await refreshPersonal();
}
export async function cancelMessageReminder(room: string, message: string) {
  await api(`/rooms/${room}/messages/${message}/reminder`, undefined, 'DELETE');
  await refreshPersonal();
}
export async function completeMessageReminder(id: string) {
  await api(`/me/message-reminders/${id}/complete`, {}, 'POST');
  await refreshPersonal();
}
