import { useState, useSyncExternalStore } from 'react';
import { Cloud, Copy, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SettingRow } from '@/features/settings/SettingRow';
import {
  draftScope,
  draftsSnapshot,
  refreshDrafts,
  resolveDraftConflict,
  setDraftSync,
  subscribeDrafts,
} from './draftStore';
import { formatMessagePreview } from '@/features/chat/messageFormatting';

export function DraftSyncSettings({ userId }: { userId: string }) {
  const state = useSyncExternalStore(subscribeDrafts, draftsSnapshot);
  const current = state.userId === userId;
  return (
    <div className="space-y-2">
      <SettingRow
        as="div"
        title="Sync text drafts"
        description="Continue messages on any signed-in device. Files and voice notes stay on this device. Conflicting text is preserved for you to choose."
        control={
          <Switch
            aria-label="Sync text drafts"
            checked={current && state.enabled}
            disabled={!current || !state.ready || state.busy}
            onCheckedChange={(enabled) => {
              void setDraftSync(enabled);
            }}
          />
        }
      />
      {current && state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11"
            onClick={() => void refreshDrafts()}
          >
            <RefreshCw size={14} />
            Retry draft sync
          </Button>
        </p>
      )}
    </div>
  );
}
export function DraftStatus({
  roomId,
  root,
}: {
  roomId: string;
  root?: string;
}) {
  const state = useSyncExternalStore(subscribeDrafts, draftsSnapshot);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const entry = state.entries[draftScope(roomId, root)];
  if (!entry || !state.enabled) return null;
  const conflict = entry.conflict;
  async function copy() {
    if (!conflict) return;
    try {
      await navigator.clipboard.writeText(conflict.body);
      setCopied(true);
      setCopyError('');
    } catch {
      setCopyError('Copy the other draft from the text below.');
    }
  }
  if (conflict)
    return (
      <section
        className="mb-2 animate-bc-rise rounded-2xl border border-primary/30 bg-primary/5 p-3.5 shadow-[var(--highlight)]"
        aria-label="Draft conflict"
      >
        <h3 className="font-heading text-sm font-semibold">
          Another device has a different draft
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Your text stays in the composer. Choose which draft to continue;
          neither was silently overwritten.
        </p>
        <p className="my-2.5 max-h-28 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-background/70 px-3 py-2 text-sm [overflow-wrap:anywhere]">
          {formatMessagePreview(conflict.body) ||
            'The other device cleared this draft.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="min-h-11"
            onClick={() => resolveDraftConflict(roomId, 'local', root)}
          >
            Keep this device
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            onClick={() => resolveDraftConflict(roomId, 'remote', root)}
          >
            Use other draft
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11"
            onClick={() => void copy()}
          >
            <Copy size={14} />
            {copied ? 'Copied' : 'Copy other draft'}
          </Button>
        </div>
        {copyError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {copyError}
          </p>
        )}
      </section>
    );
  const error = entry.error || state.error;
  if (error)
    return (
      <p role="status" className="mb-2 text-xs text-muted-foreground">
        {error}
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11"
          onClick={() => void refreshDrafts()}
        >
          <RefreshCw size={13} />
          Retry
        </Button>
      </p>
    );
  if (!entry.body) return null;
  return (
    <p
      role="status"
      className="mb-1 ml-1 inline-flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground [&>svg]:text-primary"
    >
      <Cloud size={12} />
      {entry.writing
        ? 'Syncing draft…'
        : !entry.ready || !state.ready
          ? 'Draft saved on this device'
          : entry.dirty
            ? 'Draft waiting to sync'
            : 'Draft synced'}
    </p>
  );
}
