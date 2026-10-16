import { useState } from 'react';
import { Ban, MessageSquare, ShieldCheck, X } from 'lucide-react';
import { api, type Room, type User } from '@/api';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';

type DMRequest = {
  id: string;
  sender_id: string;
  sender_name: string;
  receiver_id: string;
  receiver_name: string;
  body: string;
};
type Privacy = { allow_dm_requests: boolean; blocked: User[] };

export default function PrivacyPanel({ userId, onOpenRoom, onError }: {
  userId: string;
  onOpenRoom?: (room: Room) => void;
  onError: (message: string) => void;
}) {
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [requests, setRequests] = useState<DMRequest[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [settings, pending] = await Promise.all([
      api<Privacy>('/privacy'),
      api<{ requests: DMRequest[] }>('/dm-requests'),
    ]);
    setPrivacy(settings);
    setRequests(pending.requests ?? []);
  }
  useMountEffect(() => {
    void refresh().catch((error) => onError(errorMessage(error)));
  });
  async function action(run: () => Promise<void>) {
    setBusy(true);
    try {
      await run();
      await refresh();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 border-t pt-4" aria-label="Message privacy">
      <h3 className="flex items-center gap-2 font-heading text-base font-semibold"><ShieldCheck size={16} /> Message privacy</h3>
      {!privacy ? <p className="text-xs text-muted-foreground">Loading privacy settings…</p> : (
        <label className="flex items-center gap-3 rounded-2xl border border-border bg-card/60 p-4 text-sm transition hover:border-foreground/20 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/8 has-[:checked]:shadow-[var(--glow-brand)]">
          <input
            type="checkbox" className="accent-primary"
            checked={privacy.allow_dm_requests}
            disabled={busy}
            onChange={(event) => {
              const allowed = event.target.checked;
              void action(async () => {
                await api('/privacy', { allow_dm_requests: allowed }, 'PUT');
              });
            }}
          />
          Allow message requests from people who are not friends
        </label>
      )}
      <p className="text-xs text-muted-foreground">Requests show text only. You decide whether to open a direct conversation.</p>
      {requests.filter((request) => request.receiver_id === userId).map((request) => (
        <div key={request.id} className="rounded-2xl bc-card p-4 text-xs">
          <strong className="text-sm font-semibold">{request.sender_name}</strong>
          <p className="my-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{request.body}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void action(async () => {
              const result = await api<{ room: Room }>(`/dm-requests/${request.id}/accept`, {}, 'POST');
              onOpenRoom?.(result.room);
            })}><MessageSquare size={14} /> Accept</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void action(async () => {
              await api(`/dm-requests/${request.id}/decline`, {}, 'POST');
            })}><X size={14} /> Decline</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(async () => {
              await api(`/privacy/blocks/${request.sender_id}`, {}, 'POST');
            })}><Ban size={14} /> Block</Button>
          </div>
        </div>
      ))}
      {requests.filter((request) => request.sender_id === userId).map((request) => (
        <div key={request.id} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs hover:bg-accent/50">
          <span>Request to {request.receiver_name} pending</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(async () => {
            await api(`/dm-requests/${request.id}/decline`, {}, 'POST');
          })}>Cancel</Button>
        </div>
      ))}
      {!!privacy?.blocked.length && <h4 className="bc-kicker">Blocked people</h4>}
      {privacy?.blocked.map((person) => (
        <div key={person.id} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs hover:bg-accent/50">
          <span>{person.name}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(async () => {
            await api(`/privacy/blocks/${person.id}`, undefined, 'DELETE');
          })}>Unblock</Button>
        </div>
      ))}
    </section>
  );
}
