import { useState } from 'react';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';

type Invitation = { id: string; room_id: string; created_at: string; expires_at: string | null; max_uses: number; uses: number; revoked_at: string | null };
export default function RoomInviteLinks({ roomId }: { roomId: string }) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [expires, setExpires] = useState('604800');
  const [uses, setUses] = useState('100');
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signalForRequest = useLifetimeSignal();
  useMountEffect(() => {
    const controller = new AbortController();
    void api<{ invites: Invitation[] }>(`/rooms/${roomId}/invites`, undefined, 'GET', controller.signal)
      .then((result) => { if (!controller.signal.aborted) setInvitations(result.invites ?? []); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  });
  async function create() {
    const signal = signalForRequest();
    setBusy(true); setError(''); setCopied(false);
    try {
      const result = await api<{ invite: Invitation; url: string }>(`/rooms/${roomId}/invites`, { expires_in_seconds: Number(expires), max_uses: Number(uses) }, 'POST', signal);
      signal.throwIfAborted();
      setInvitations((current) => [result.invite, ...current]); setUrl(result.url);
    } catch (reason) { if (!signal.aborted) setError(errorMessage(reason)); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  async function revoke(invite: Invitation) {
    const signal = signalForRequest();
    setBusy(true); setError('');
    try { await api(`/rooms/${roomId}/invites/${invite.id}`, undefined, 'DELETE', signal); signal.throwIfAborted(); setInvitations((current) => current.map((item) => item.id === invite.id ? { ...item, revoked_at: new Date().toISOString() } : item)); setUrl(''); }
    catch (reason) { if (!signal.aborted) setError(errorMessage(reason)); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setCopied(true); setError('');
    } catch { setError('Select and copy the invitation link above.'); }
  }
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Invitation links">
      <div><h3 className="text-sm font-semibold">Invitation links</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Anyone with a valid link can sign in and join this room, including its history. Copy a new link before closing this panel.</p></div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs">Expires after<select aria-label="Invitation expiry" className="mt-2 w-full" value={expires} disabled={busy} onChange={(event) => setExpires(event.target.value)}><option value="3600">1 hour</option><option value="86400">1 day</option><option value="604800">7 days</option><option value="2592000">30 days</option><option value="0">Never</option></select></label>
        <label className="text-xs">Maximum uses<Input className="mt-2" type="number" min={0} max={1000} value={uses} disabled={busy} onChange={(event) => setUses(event.target.value)} /><span className="mt-1 block text-muted-foreground">0 means unlimited.</span></label>
      </div>
      <Button variant="secondary" disabled={loading || busy || uses === '' || !Number.isInteger(Number(uses)) || Number(uses) < 0 || Number(uses) > 1000} onClick={() => void create()}>Create invitation link</Button>
      {url && <div className="space-y-2 rounded-xl border p-3"><Input aria-label="New invitation link" readOnly value={url} onFocus={(event) => event.currentTarget.select()} /><Button size="sm" variant="secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</Button></div>}
      {loading && <p className="text-xs text-muted-foreground">Loading invitation links…</p>}
      <div className="max-h-40 space-y-2 overflow-y-auto">{invitations.map((invite) => {
        const inactive = Boolean(invite.revoked_at) || Boolean(invite.expires_at && Date.parse(invite.expires_at) <= Date.now()) || (invite.max_uses > 0 && invite.uses >= invite.max_uses);
        return <div key={invite.id} className="flex items-center justify-between gap-2 rounded-lg border p-2 text-xs"><span className="min-w-0"><strong className="block">{invite.revoked_at ? 'Revoked' : inactive ? 'Expired or exhausted' : 'Active invitation'}</strong><span className="block text-muted-foreground">{invite.uses}/{invite.max_uses || '∞'} uses · {invite.expires_at ? `Expires ${new Date(invite.expires_at).toLocaleString()}` : 'No expiry'}</span></span>{!inactive && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(invite)}>Revoke</Button>}</div>;
      })}</div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
