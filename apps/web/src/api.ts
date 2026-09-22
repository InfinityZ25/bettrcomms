import {
  apiAuthHeaders,
  apiCredentials,
  apiHttpUrl,
} from "@/desktop/apiTransport";

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
  kind?: "channel" | "direct";
  role?: string;
  display_name?: string;
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
}
export interface FriendRequest {
  id: string;
  sender: User;
  receiver: User;
  status: string;
  created_at: string;
}
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(apiHttpUrl("/api/v1" + path), {
    credentials: apiCredentials(),
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      ...apiAuthHeaders(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(
      error?.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
