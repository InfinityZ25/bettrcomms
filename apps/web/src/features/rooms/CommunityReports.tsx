import { useState } from 'react';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';

type Report = {
  id: string;
  message_id: string;
  reporter_name: string;
  author_name: string;
  excerpt: string;
  reason: string;
};
export default function CommunityReports({
  roomId,
  onChanged,
}: {
  roomId: string;
  onChanged: () => void;
}) {
  const [reports, setReports] = useState<Report[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const signalForRequest = useLifetimeSignal();
  async function load() {
    const signal = signalForRequest();
    setError('');
    setLoading(true);
    try {
      const result = await api<{ reports: Report[] }>(
        `/rooms/${roomId}/reports`,
        undefined,
        'GET',
        signal,
      );
      if (!signal.aborted) setReports(result.reports ?? []);
    } catch (failure) {
      if (!signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }
  useMountEffect(() => {
    void load();
  });
  async function resolve(report: Report, remove: boolean) {
    if (busy) return;
    const signal = signalForRequest();
    setBusy(true);
    setError('');
    try {
      await api(
        remove
          ? `/rooms/${roomId}/messages/${report.message_id}/moderation`
          : `/rooms/${roomId}/reports/${report.id}/dismiss`,
        remove ? { reason: `Report: ${report.reason}`.slice(0, 500) } : {},
        remove ? 'DELETE' : 'POST',
        signal,
      );
      if (!signal.aborted) {
        setReports((current) =>
          current.filter((item) =>
            remove
              ? item.message_id !== report.message_id
              : item.id !== report.id,
          ),
        );
        onChanged();
      }
    } catch (failure) {
      if (!signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Message reports">
      <h3 className="text-sm font-semibold">Message reports</h3>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading reports…</p>
      ) : (
        !reports.length && (
          <p className="text-sm text-muted-foreground">
            No open reports in this channel.
          </p>
        )
      )}
      {reports.map((report) => (
        <article
          key={report.id}
          className="space-y-2 rounded-lg border p-3 text-xs"
        >
          <p>
            <strong>{report.reporter_name}</strong> reported{' '}
            {report.author_name}
          </p>
          <p className="truncate text-muted-foreground">{report.excerpt}</p>
          <p className="break-words">{report.reason}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void resolve(report, true)}
            >
              Remove message
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void resolve(report, false)}
            >
              Dismiss
            </Button>
          </div>
        </article>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}{' '}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      )}
    </section>
  );
}
