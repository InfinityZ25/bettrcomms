import {
  apiAuthHeaders,
  apiCredentials,
  apiHttpUrl,
} from '@/desktop/apiTransport';
import {
  sessionExpired,
  sessionGeneration,
} from '@/features/auth/sessionEvents';

export interface CustomStatus {
  text: string;
  emoji: string;
  expires_at?: string | null;
}
export interface PublicUser {
  id: string;
  name: string;
  username?: string | null;
  bio?: string;
  profile_version?: number;
  custom_status?: CustomStatus;
  status_version?: number;
  /** A trusted provider picture or a versioned authenticated API resource. */
  avatar_url?: string | null;
}
export interface User extends PublicUser {
  email: string;
  /** Desired account status; the API only includes this on your own profile. */
  presence_status?: 'online' | 'idle' | 'dnd' | 'invisible';
}
export type CommunityRole = 'owner' | 'admin' | 'moderator' | 'member';
export type ChannelType = 'hybrid' | 'announcement';
export interface RoomPermissions {
  read?: boolean;
  manage_channels: boolean;
  manage_members: boolean;
  manage_roles: boolean;
  moderate: boolean;
  post: boolean;
  join_voice: boolean;
  manage_community: boolean;
  manage_invites: boolean;
  pin_messages: boolean;
}
export interface Room {
  is_private?: boolean;
  slow_mode_seconds?: number;
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  kind?: 'channel' | 'direct' | 'group';
  role?: string;
  display_name?: string;
  activity_at?: string;
  community_id?: string;
  community_name?: string;
  channel_type?: ChannelType;
  topic?: string;
  position?: number;
  can_post?: boolean;
  can_join_voice?: boolean;
  permissions?: RoomPermissions;
}
export interface Community {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  role: CommunityRole;
  created_at: string;
  updated_at: string;
  channels: Room[];
}
export interface RoomMember {
  custom_role_ids?: string[];
  user: PublicUser;
  role: CommunityRole;
  restricted_until?: string;
}
export interface MessageAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  voice_note?: boolean;
  duration_ms?: number;
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
    public code?: string,
    public retryAfter?: number,
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
  const generation = sessionGeneration();
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
    if (response.status === 401 && !signal?.aborted) sessionExpired(generation);
    throw new ApiRequestError(
      error?.error?.message ?? `Request failed (${response.status})`,
      response.status,
      error?.error?.code,
      Number(response.headers.get('Retry-After')) || undefined,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export async function uploadMessageAttachment(
  roomId: string,
  file: File,
  signal?: AbortSignal,
  options?: { voiceNote: boolean; durationMs: number },
): Promise<MessageAttachment> {
  if (!options?.voiceNote) {
    const { uploadAttachmentWithProgress } = await import('@/features/chat/attachmentFiles');
    return uploadAttachmentWithProgress(roomId, file, {
      signal: signal ?? new AbortController().signal,
      onProgress: () => {},
    });
  }
  const generation = sessionGeneration();
  const body = new FormData();
  body.append('file', file);
  if (options?.voiceNote) {
    body.append('voice_note', 'true');
    body.append('duration_ms', String(options.durationMs));
  }
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
    if (response.status === 401 && !signal?.aborted) sessionExpired(generation);
    throw new ApiRequestError(
      error?.error?.message ?? `Upload failed (${response.status})`,
      response.status,
      error?.error?.code,
      Number(response.headers.get('Retry-After')) || undefined,
    );
  }
  return (await response.json()).attachment as MessageAttachment;
}
