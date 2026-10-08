import { useRef, useState, type FormEvent } from 'react';
import { FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import { api, type RoomMember } from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import MessageAttachmentPreview from './MessageAttachmentPreview';
import { downloadMessageAttachment } from './attachmentFiles';
import {
  deleteChannelFile,
  loadChannelFiles,
  type LibraryFile,
  type LibraryFilters,
} from './storageFeatures';

type Props = {
  roomId: string;
  userId: string;
  canModerate?: boolean;
  onError: (message: string) => void;
  onClose: () => void;
};
const emptyFilters: LibraryFilters = { type: '', author: '', from: '', to: '' };
function LibraryResults({
  roomId,
  userId,
  canModerate,
  onError,
  filters,
}: Omit<Props, 'onClose'> & { filters: LibraryFilters }) {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState('');
  const inflight = useRef<AbortSignal | null>(null);
  const lifetime = useLifetimeSignal();
  const load = async (next = '') => {
    const signal = lifetime();
    if (inflight.current && !inflight.current.aborted) return;
    inflight.current = signal;
    setLoading(true);
    setError('');
    try {
      const result = await loadChannelFiles(roomId, filters, next, signal);
      if (signal.aborted) return;
      setFiles((previous) =>
        next
          ? [
              ...previous,
              ...result.files.filter(
                (item) => !previous.some((old) => old.id === item.id),
              ),
            ]
          : result.files,
      );
      setCursor(result.next_cursor ?? '');
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not load channel files',
        );
    } finally {
      if (inflight.current === signal) inflight.current = null;
      if (!signal.aborted) setLoading(false);
    }
  };
  useMountEffect(() => {
    void load();
  });
  const remove = async (file: LibraryFile) => {
    if (
      deleting ||
      !window.confirm(
        `Delete ${file.filename} from this channel? The original file will no longer be available in its message.`,
      )
    )
      return;
    setDeleting(file.id);
    try {
      await deleteChannelFile(roomId, file.id, lifetime());
      if (!lifetime().aborted)
        setFiles((current) => current.filter((item) => item.id !== file.id));
    } catch (failure) {
      if (!lifetime().aborted)
        onError(
          failure instanceof Error ? failure.message : 'Could not delete file',
        );
    } finally {
      if (!lifetime().aborted) setDeleting('');
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto pr-1">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          Files shared in this channel
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw />
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="mb-3 rounded-lg border p-3 text-sm">
          {error}
        </p>
      )}
      {!loading && !error && files.length === 0 && (
        <div className="flex flex-col items-center gap-3 p-10 text-center text-sm text-muted-foreground">
          <FolderOpen className="size-8" />
          <p>No files match these filters.</p>
        </div>
      )}
      <ul className="grid gap-3 sm:grid-cols-2" aria-label="Channel files">
        {files.map((file) => (
          <li key={file.id} className="min-w-0 rounded-xl border bg-card p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0 text-xs text-muted-foreground">
                <p className="truncate">{file.author_name}</p>
                <time dateTime={file.created_at}>
                  {new Date(file.created_at).toLocaleDateString()}
                </time>
              </div>
              {file.message_id &&
                (file.author_id === userId || canModerate) && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete file ${file.filename}`}
                    disabled={!!deleting}
                    onClick={() => void remove(file)}
                  >
                    <Trash2 />
                  </Button>
                )}
            </div>
            <MessageAttachmentPreview
              roomId={roomId}
              attachment={file}
              onError={onError}
              onDownload={() =>
                void downloadMessageAttachment(roomId, file.id, file.filename, {
                  signal: lifetime(),
                  onError,
                })
              }
            />
          </li>
        ))}
      </ul>
      {loading && (
        <p
          role="status"
          className="p-6 text-center text-sm text-muted-foreground"
        >
          Loading files…
        </p>
      )}
      {cursor && (
        <Button
          variant="outline"
          className="mt-4 w-full"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          Load older files
        </Button>
      )}
    </div>
  );
}
function Library({ roomId, ...props }: Props) {
  const [filters, setFilters] = useState(emptyFilters);
  const [query, setQuery] = useState(emptyFilters);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const lifetime = useLifetimeSignal();
  useMountEffect(() => {
    const signal = lifetime();
    void api<{ members: RoomMember[] }>(
      `/rooms/${roomId}/members`,
      undefined,
      undefined,
      signal,
    )
      .then((result) => {
        if (!signal.aborted) setMembers(result.members);
      })
      .catch(() => {});
  });
  const apply = (event: FormEvent) => {
    event.preventDefault();
    setQuery({ ...filters });
  };
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title="Channel files"
      description="Find shared images, videos, documents and audio."
      className="flex max-h-[calc(100dvh-2rem)] min-h-[min(38rem,80dvh)] flex-col overflow-hidden sm:max-w-4xl"
    >
      <form
        onSubmit={apply}
        className="grid grid-cols-2 items-end gap-2 sm:grid-cols-5"
      >
        <label className="space-y-1 text-xs">
          Type
          <select
            aria-label="File type"
            value={filters.type}
            onChange={(event) =>
              setFilters({ ...filters, type: event.target.value })
            }
            className="h-9 w-full rounded-lg border bg-background px-2 text-sm"
          >
            <option value="">All files</option>
            <option value="image">Images</option>
            <option value="video">Videos</option>
            <option value="audio">Audio</option>
            <option value="pdf">PDF</option>
            <option value="document">Documents & archives</option>
          </select>
        </label>
        <label className="space-y-1 text-xs">
          Author
          <select
            aria-label="File author"
            value={filters.author}
            onChange={(event) =>
              setFilters({ ...filters, author: event.target.value })
            }
            className="h-9 w-full rounded-lg border bg-background px-2 text-sm"
          >
            <option value="">Everyone</option>
            {members.map((member) => (
              <option key={member.user.id} value={member.user.id}>
                {member.user.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          From
          <Input
            type="date"
            aria-label="Files from date"
            value={filters.from}
            onChange={(event) =>
              setFilters({ ...filters, from: event.target.value })
            }
          />
        </label>
        <label className="space-y-1 text-xs">
          Through
          <Input
            type="date"
            aria-label="Files through date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(event) =>
              setFilters({ ...filters, to: event.target.value })
            }
          />
        </label>
        <Button type="submit" variant="outline">
          Apply filters
        </Button>
      </form>
      <LibraryResults
        key={JSON.stringify(query)}
        roomId={roomId}
        {...props}
        filters={query}
      />
    </AppDialog>
  );
}
export default function ChannelFileLibrary(props: Props) {
  return <Library key={props.roomId} {...props} />;
}
