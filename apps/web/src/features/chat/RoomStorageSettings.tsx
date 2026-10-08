import { useState, type FormEvent } from 'react';
import { HardDrive, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { attachmentSize } from './attachmentFiles';
import {
  loadRoomStorage,
  updateRoomStorage,
  type ScannerStatus,
  type StoragePolicy,
} from './storageFeatures';

type Props = { communityId: string; onError: (message: string) => void };
function PolicyForm({
  communityId,
  initial,
  onError,
}: Props & { initial: StoragePolicy }) {
  const [policy, setPolicy] = useState(initial);
  const [quota, setQuota] = useState(
    String(initial.quota_bytes / (1024 * 1024)),
  );
  const [retention, setRetention] = useState(String(initial.retention_days));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const lifetime = useLifetimeSignal();
  const refresh = async () => {
    setBusy(true);
    try {
      const result = await loadRoomStorage(communityId, lifetime());
      if (!lifetime().aborted) setPolicy(result.storage);
    } catch (failure) {
      if (!lifetime().aborted)
        onError(
          failure instanceof Error
            ? failure.message
            : 'Could not refresh storage',
        );
    } finally {
      if (!lifetime().aborted) setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const bytes = Math.round(Number(quota) * 1024 * 1024);
    const days = Number(retention);
    if (
      !quota.trim() ||
      !retention.trim() ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > 8 * 1024 ** 4 ||
      !Number.isInteger(days) ||
      days < 0 ||
      days > 3650
    ) {
      onError(
        'Enter a quota from 0 to 8 TiB and retention from 0 to 3650 days.',
      );
      return;
    }
    if (
      days > 0 &&
      days !== policy.retention_days &&
      !window.confirm(
        `Files older than ${days} days will be permanently removed by automatic cleanup. Active stickers and soundboard assets are preserved. Apply this retention policy?`,
      )
    )
      return;
    setBusy(true);
    setSaved(false);
    try {
      const result = await updateRoomStorage(
        communityId,
        bytes,
        days,
        lifetime(),
      );
      if (!lifetime().aborted) {
        setPolicy(result.storage);
        setSaved(true);
      }
    } catch (failure) {
      if (!lifetime().aborted)
        onError(
          failure instanceof Error
            ? failure.message
            : 'Could not save storage settings',
        );
    } finally {
      if (!lifetime().aborted) setBusy(false);
    }
  };
  const total = policy.used_bytes + policy.reserved_bytes;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-muted/25 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-2xl font-semibold tabular-nums">
              {attachmentSize(policy.used_bytes)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {policy.files} files · {attachmentSize(policy.reserved_bytes)}{' '}
              reserved by uploads
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh storage usage"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw />
          </Button>
        </div>
        {policy.quota_bytes > 0 && (
          <>
            <progress
              aria-label="Room storage usage"
              value={Math.min(total, policy.quota_bytes)}
              max={policy.quota_bytes}
              className="mt-3 h-2 w-full"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {attachmentSize(total)} of {attachmentSize(policy.quota_bytes)}
            </p>
          </>
        )}
        {policy.cleanup_bytes > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {attachmentSize(policy.cleanup_bytes)} awaiting storage cleanup.
            These files are already unavailable.
          </p>
        )}
      </div>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <label className="block space-y-1.5 text-sm">
          Room quota (MiB)
          <Input
            type="number"
            aria-label="Room storage quota MiB"
            min="0"
            max="8388608"
            step="any"
            required
            value={quota}
            disabled={busy}
            onChange={(event) => {
              setQuota(event.target.value);
              setSaved(false);
            }}
          />
          <span className="block text-xs text-muted-foreground">
            0 allows unlimited room storage. Existing files count toward the
            quota; in-progress uploads reserve their full size.
          </span>
        </label>
        <label className="block space-y-1.5 text-sm">
          Keep files for (days)
          <Input
            type="number"
            aria-label="File retention days"
            min="0"
            max="3650"
            step="1"
            required
            value={retention}
            disabled={busy}
            onChange={(event) => {
              setRetention(event.target.value);
              setSaved(false);
            }}
          />
          <span className="block text-xs text-muted-foreground">
            0 keeps files until removed. Automatic retention removes older
            attachments from their messages and preserves active stickers and
            sounds.
          </span>
        </label>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save storage settings'}
        </Button>
        {saved && (
          <p role="status" className="text-xs text-muted-foreground">
            Storage settings saved.
          </p>
        )}
      </form>
    </div>
  );
}
function Settings(props: Props) {
  const [policy, setPolicy] = useState<StoragePolicy>();
  const [scanner, setScanner] = useState<ScannerStatus>();
  const [error, setError] = useState('');
  const lifetime = useLifetimeSignal();
  const load = () => {
    const signal = lifetime();
    setError('');
    void loadRoomStorage(props.communityId, signal)
      .then((result) => {
        if (!signal.aborted) {
          setPolicy(result.storage);
          setScanner(result.scanner);
        }
      })
      .catch((failure: unknown) => {
        if (!signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Could not load storage',
          );
      });
  };
  useMountEffect(load);
  return (
    <section className="space-y-4" aria-label="Room storage">
      <div className="flex items-center gap-2">
        <HardDrive className="size-4" />
        <h3 className="text-sm font-semibold">Storage & files</h3>
      </div>
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      )}
      {!policy && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading storage…
        </p>
      )}
      {scanner && (
        <p className="rounded-lg border p-3 text-xs text-muted-foreground">
          {!scanner.enabled
            ? 'Malware scanning is disabled on this server.'
            : scanner.status === 'ready'
              ? `ClamAV is reachable. New files remain private until scanned; scan limit ${attachmentSize(scanner.max_scan_bytes)}.`
              : 'ClamAV is unavailable. New files remain private and uploads cannot complete until scanning recovers.'}
        </p>
      )}
      {policy && (
        <PolicyForm key={policy.community_id} {...props} initial={policy} />
      )}
    </section>
  );
}
export default function RoomStorageSettings(props: Props) {
  return <Settings key={props.communityId} {...props} />;
}
