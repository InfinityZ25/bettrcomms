import {
  apiAuthHeaders,
  apiCredentials,
  apiHttpUrl,
} from '@/desktop/apiTransport';

export interface User {
  id: string;
  name: string;
  email: string;
  /**
   * The profile picture WorkOS supplied, its own or a provider's, or null when
   * the account has none. The API has always carried it; nothing rendered it.
   */
  avatar_url?: string | null;
}
export interface Room {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  kind?: 'channel' | 'direct';
  role?: string;
  display_name?: string;
  activity_at?: string;
}
export interface MessageAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}
export interface CallParticipant {
  user_id: string;
  name?: string;
  muted: boolean;
  deafened: boolean;
  device_count: number;
}
export interface Message {
  id: string;
  room_id: string;
  author: User;
  body: string;
  created_at: string;
  sequence?: number;
  version?: number;
  edited_at?: string;
  deleted_at?: string;
  mentions?: { id: string; name: string }[];
  reply?: { id: string; name: string; body: string; deleted: boolean };
  reactions?: { emoji: string; users: string[] }[];
  attachments?: MessageAttachment[];
  thread_root_id?: string;
  thread_reply_count?: number;
  thread_unread_count?: number;
  pinned_at?: string;
  pinned_by?: string;
}
export interface MessagePage {
  messages: Message[];
  before_id?: string;
  read_sequence?: number;
  root?: Message;
}
export interface RoomUnread {
  room_id: string;
  unread: number;
  mentions: number;
  read_sequence: number;
}
export interface FriendRequest {
  id: string;
  sender: User;
  receiver: User;
  status: string;
  created_at: string;
}
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(apiHttpUrl('/api/v1' + path), {
    signal,
    credentials: apiCredentials(),
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      ...apiAuthHeaders(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiRequestError(
      error?.error?.message ?? `Request failed (${response.status})`,
      response.status,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export async function uploadMessageAttachment(
  roomId: string,
  file: File,
  signal?: AbortSignal,
): Promise<MessageAttachment> {
  const body = new FormData();
  body.append('file', file);
  const response = await fetch(
    apiHttpUrl(`/api/v1/rooms/${roomId}/attachments`),
    {
      method: 'POST',
      signal,
      credentials: apiCredentials(),
      headers: apiAuthHeaders(),
      body,
    },
  );
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiRequestError(
      error?.error?.message ?? `Upload failed (${response.status})`,
      response.status,
    );
  }
  return (await response.json()).attachment as MessageAttachment;
}
