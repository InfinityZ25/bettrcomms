import { useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { api, type MessageEditVersion } from './activityApi';

export function MessageHistory({
  roomId,
  messageId,
  onClose,
}: {
  roomId: string;
  messageId: string;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<MessageEditVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const lifetime = useLifetimeSignal();
  async function load() {
    const signal = lifetime();
    setLoading(true);
    setError('');
    try {
      const value = await api<{ versions: MessageEditVersion[] }>(
        `/rooms/${roomId}/messages/${messageId}/history`,
        undefined,
        undefined,
        signal,
      );
      if (!signal.aborted) setVersions(value.versions);
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not load edit history.',
        );
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }
  useMountEffect(() => {
    void load();
  });
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit history"
      description="Previous text versions are visible to members who can read this conversation. Deleted messages erase their history."
      className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
    >
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading versions…
        </p>
      )}
      {!loading && !error && !versions.length && (
        <p className="text-sm text-muted-foreground">
          No retained edits. History starts with edits made after this feature
          was enabled.
        </p>
      )}
      <ol className="space-y-3">
        {versions.map((version, index) => (
          <li key={version.version} className="rounded-xl border p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <strong className="text-foreground">
                {index === 0 ? 'Latest text' : `Version ${version.version}`}
              </strong>
              <time dateTime={version.changed_at}>
                {new Date(version.changed_at).toLocaleString()}
              </time>
            </div>
            <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
              {version.body || 'Attachment only'}
            </p>
          </li>
        ))}
      </ol>
    </AppDialog>
  );
}
