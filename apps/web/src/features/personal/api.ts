import { api, type Message, type MessageAttachment } from '@/api';

export { api };
export type SavedKind = 'message' | 'file';
export interface SavedItem {
  id: string;
  kind: SavedKind;
  room_id: string;
  room_name: string;
  message?: Message;
  attachment?: MessageAttachment;
  created_at: string;
}
export interface MessageReminder {
  id: string;
  room_id: string;
  room_name: string;
  message: Message;
  due_at: string;
  created_at: string;
  state: 'pending' | 'due';
  version: number;
}
export interface TextDraft {
  room_id: string;
  thread_root_id?: string;
  body: string;
  reply_to_id?: string;
  version: number;
  mutation_id?: string;
  updated_at?: string;
}
export interface QuietHours {
  version: number;
  enabled: boolean;
  timezone: string;
  weekdays: number[];
  start_time: string;
  end_time: string;
  active: boolean;
  quiet_until?: string;
  next_change_at?: string;
  server_time: string;
  account_dnd: boolean;
}
export type QuietSchedule = Pick<
  QuietHours,
  'enabled' | 'timezone' | 'weekdays' | 'start_time' | 'end_time'
>;
export interface DraftSyncSetting {
  enabled: boolean;
  version: number;
}
export type PersonalEvent =
  | 'personal.saved.changed'
  | 'personal.reminders.changed'
  | 'personal.drafts.changed'
  | 'notification.policy.changed'
  | 'draft-sync.changed';
const listeners = new Set<(type: PersonalEvent) => void>();
export function receivePersonalEvent(type: PersonalEvent) {
  for (const listener of listeners) {
    try {
      listener(type);
    } catch {
      /* One stale view must not block account-wide reconciliation. */
    }
  }
}
export function subscribePersonalEvents(
  listener: (type: PersonalEvent) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
