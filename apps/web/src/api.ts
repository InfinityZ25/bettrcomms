export interface User {
  id: string;
  name: string;
  email: string;
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
  const response = await fetch("/api/v1" + path, {
    credentials: "include",
    method: method ?? (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : undefined,
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
