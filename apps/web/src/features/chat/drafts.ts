import type { MessageAttachment } from '@/api';

export type PendingAttachment = MessageAttachment & {
  file?: File;
  localId?: string;
  uploadState?: 'queued' | 'uploading' | 'ready' | 'failed' | 'cancelled';
  progress?: number;
  uploadError?: string;
};
export type SavedDraft = {
  body: string;
  attachments: PendingAttachment[];
  nonce?: string;
  fingerprint?: string;
};

const key = (user: string, room: string, root?: string) =>
  `bettercomms:draft:${user}:${room}${root ? `:thread:${root}` : ''}`;
const attachmentLifetime = 24 * 60 * 60 * 1000;

export function readDraft(
  user: string,
  room: string,
  root?: string,
): SavedDraft {
  try {
    const value = JSON.parse(
      localStorage.getItem(key(user, room, root)) ?? '{}',
    ) as Partial<SavedDraft> & { savedAt?: number };
    return {
      body: typeof value.body === 'string' ? value.body.slice(0, 4000) : '',
      attachments:
        typeof value.savedAt === 'number' &&
        Date.now() - value.savedAt < attachmentLifetime &&
        Array.isArray(value.attachments)
          ? value.attachments
              .filter(
                (item) =>
                  item &&
                  typeof item.id === 'string' &&
                  item.id &&
                  typeof item.filename === 'string' &&
                  typeof item.content_type === 'string' &&
                  Number.isFinite(item.size_bytes) &&
                  item.size_bytes > 0,
              )
              .slice(0, 4)
              .map((item) => ({
                id: item.id,
                filename: item.filename,
                content_type: item.content_type,
                size_bytes: item.size_bytes,
                voice_note: item.voice_note === true,
                duration_ms:
                  typeof item.duration_ms === 'number'
                    ? item.duration_ms
                    : undefined,
                uploadState: 'ready' as const,
              }))
          : [],
      nonce: value.nonce,
      fingerprint: value.fingerprint,
    };
  } catch {
    return { body: '', attachments: [] };
  }
}

export function saveDraft(
  user: string,
  room: string,
  draft: SavedDraft,
  root?: string,
) {
  try {
    localStorage.setItem(
      key(user, room, root),
      JSON.stringify({
        ...draft,
        savedAt: Date.now(),
        attachments: draft.attachments
          .filter((item) => item.id)
          .map((item) => ({
            id: item.id,
            filename: item.filename,
            content_type: item.content_type,
            size_bytes: item.size_bytes,
            voice_note: item.voice_note,
            duration_ms: item.duration_ms,
          })),
      }),
    );
  } catch {
    // A disabled storage area must not block messaging.
  }
}

export function clearDraft(user: string, room: string, root?: string) {
  try {
    localStorage.removeItem(key(user, room, root));
  } catch {
    // The sent message is already saved on the server.
  }
}
