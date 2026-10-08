import { api, type MessageAttachment } from '@/api';
export type LibraryFile = MessageAttachment & {
  room_id: string;
  message_id?: string;
  author_id?: string;
  author_name: string;
  created_at: string;
};
export type LibraryFilters = {
  type: string;
  author: string;
  from: string;
  to: string;
};
export type FileLibraryPage = { files: LibraryFile[]; next_cursor?: string };
export type StoragePolicy = {
  community_id: string;
  quota_bytes: number;
  retention_days: number;
  used_bytes: number;
  reserved_bytes: number;
  cleanup_bytes: number;
  files: number;
};
export type ScannerStatus = {
  enabled: boolean;
  status: 'disabled' | 'ready' | 'unavailable';
  max_scan_bytes: number;
};
export function loadChannelFiles(
  room: string,
  filters: LibraryFilters,
  cursor: string,
  signal: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filters.type) query.set('type', filters.type);
  if (filters.author) query.set('author', filters.author);
  if (filters.from)
    query.set('from', new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    query.set('to', end.toISOString());
  }
  if (cursor) query.set('cursor', cursor);
  return api<FileLibraryPage>(
    `/rooms/${room}/files?${query}`,
    undefined,
    undefined,
    signal,
  );
}
export function deleteChannelFile(
  room: string,
  id: string,
  signal: AbortSignal,
) {
  return api<void>(`/rooms/${room}/files/${id}`, undefined, 'DELETE', signal);
}
export function loadRoomStorage(community: string, signal: AbortSignal) {
  return api<{ storage: StoragePolicy; scanner: ScannerStatus }>(
    `/communities/${community}/storage`,
    undefined,
    undefined,
    signal,
  );
}
export function updateRoomStorage(
  community: string,
  quota: number,
  retention: number,
  signal: AbortSignal,
) {
  return api<{ storage: StoragePolicy }>(
    `/communities/${community}/storage`,
    { quota_bytes: quota, retention_days: retention },
    'PATCH',
    signal,
  );
}
