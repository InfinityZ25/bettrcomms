import { useRef, useState } from 'react';
import { api, type Room, type User } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';

type Ban = { user: User; reason: string; created_at: string };
type Audit = { action: string; actor_name: string; target_name?: string; reason: string; created_at: string };
type Member = { user: User; restricted_until?: string };
type Controls = { state: { slow_mode_seconds: number }; bans: Ban[]; bans_next: string; audit: Audit[] };

export default function ModerationSettings({ room, user, onChanged }: { room: Room; user: User; onChanged: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [bans, setBans] = useState<Ban[]>([]);
  const [bansNext, setBansNext] = useState('');
  const [audit, setAudit] = useState<Audit[]>([]);
  const [slow, setSlow] = useState('0');
  const [target, setTarget] = useState('');
  const [duration, setDuration] = useState('600');
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<'timeout' | 'ban'>('timeout');
  const [confirmBan, setConfirmBan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const load = async (signal: AbortSignal, initial = false) => {
    const [people, controls] = await Promise.all([
      api<{ members: Member[] }>(`/rooms/${room.id}/members`, undefined, undefined, signal),
      api<Controls>(`/rooms/${room.id}/moderation`, undefined, undefined, signal),
    ]);
    if (signal.aborted) return;
    setMembers(people.members.filter((member) => member.user.id !== user.id)); setBans(controls.bans ?? []); setBansNext(controls.bans_next); setAudit(controls.audit ?? []);
    if (initial) setSlow(String(controls.state.slow_mode_seconds));
  };
  useMountEffect(() => { const controller = new AbortController(); request.current = controller; void load(controller.signal, true).catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); }); return () => controller.abort(); });
  const run = async (fn: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = request.current; if (!controller || controller.signal.aborted || busy) return;
    setBusy(true); setError('');
    try { await fn(controller.signal); await load(controller.signal); if (!controller.signal.aborted) { setConfirmBan(false); onChanged(); } }
    catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const loadMoreBans = async () => {
    const controller = request.current; if (!controller || controller.signal.aborted || busy || !bansNext) return;
    setBusy(true); setError('');
    try {
      const page = await api<Controls>(`/rooms/${room.id}/moderation?bans_after=${encodeURIComponent(bansNext)}`, undefined, undefined, controller.signal);
      if (!controller.signal.aborted) { setBans((current) => [...current, ...page.bans.filter((ban) => !current.some((item) => item.user.id === ban.user.id))]); setBansNext(page.bans_next); }
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <section className="space-y-4 border-t border-border pt-4" aria-label="Channel moderation">
    <h3 className="text-sm font-semibold">Moderation</h3>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void run((signal) => api(`/rooms/${room.id}/moderation/slow-mode`, { seconds: Number(slow) }, 'PUT', signal)); }}>
      <label className="min-w-0 flex-1 space-y-1 text-xs"><span>Slow mode (seconds, 0 disables)</span><Input type="number" value={slow} onChange={(event) => setSlow(event.target.value)} min={0} max={3600} required /></label>
      <Button type="submit" variant="outline" disabled={busy}>Save slow mode</Button>
      <p className="w-full text-xs text-muted-foreground">Applies to new messages across devices. The channel owner is exempt.</p>
    </form>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (action === 'ban' && !confirmBan) { setConfirmBan(true); return; } void run((signal) => api(`/rooms/${room.id}/moderation/${action === 'ban' ? 'bans' : 'timeouts'}/${target}`, { reason, seconds: Number(duration) }, 'PUT', signal)); }}>
      <label className="block space-y-1 text-xs"><span>Member to moderate</span><select aria-label="Member to moderate" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={target} onChange={(event) => { setTarget(event.target.value); setConfirmBan(false); }} required><option value="">Choose a member</option>{members.map((member) => <option key={member.user.id} value={member.user.id}>{member.user.name}</option>)}</select></label>
      <div className="flex flex-wrap gap-3">
        <label className="flex-1 space-y-1 text-xs"><span>Action</span><select aria-label="Moderation action" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={action} onChange={(event) => { setAction(event.target.value as typeof action); setConfirmBan(false); }}><option value="timeout">Restrict posting temporarily</option><option value="ban">Ban from channel</option></select></label>
        {action === 'timeout' && <label className="flex-1 space-y-1 text-xs"><span>Duration</span><select aria-label="Posting restriction duration" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={duration} onChange={(event) => setDuration(event.target.value)}><option value="60">1 minute</option><option value="600">10 minutes</option><option value="3600">1 hour</option><option value="86400">1 day</option><option value="604800">7 days</option></select></label>}
      </div>
      <label className="block space-y-1 text-xs"><span>Reason (3–500 characters)</span><textarea className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={500} required /></label>
      {confirmBan && <p role="status" className="text-xs text-destructive">This removes their access and stops their call. They cannot rejoin until unbanned.</p>}
      <Button type="submit" variant={action === 'ban' ? 'destructive' : 'outline'} disabled={busy || !target || reason.trim().length < 3}>{confirmBan ? 'Confirm ban' : action === 'ban' ? 'Ban member…' : 'Restrict posting'}</Button>
    </form>
    {members.filter((member) => member.restricted_until && Date.parse(member.restricted_until) > Date.now()).map((member) => <div key={member.user.id} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{member.user.name} · restricted until {new Date(member.restricted_until!).toLocaleString()}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => void run((signal) => api(`/rooms/${room.id}/moderation/timeouts/${member.user.id}`, undefined, 'DELETE', signal))}>Remove restriction</Button></div>)}
    <div className="space-y-2"><h4 className="text-xs font-semibold">Banned members</h4>{!bans.length && <p className="text-xs text-muted-foreground">No active bans.</p>}{bans.map((ban) => <div key={ban.user.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 py-2 text-xs"><div><strong>{ban.user.name}</strong><p className="break-words text-muted-foreground">{ban.reason}</p></div><Button variant="outline" size="sm" disabled={busy} onClick={() => void run((signal) => api(`/rooms/${room.id}/moderation/bans/${ban.user.id}`, undefined, 'DELETE', signal))}>Unban</Button></div>)}</div>
    {bansNext && <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadMoreBans()}>Load more banned members</Button>}
    <details className="text-xs"><summary className="cursor-pointer font-semibold">Recent moderation actions</summary><ol className="mt-2 max-h-56 space-y-2 overflow-auto">{audit.map((entry, index) => <li key={`${entry.created_at}:${index}`}><strong>{entry.actor_name}</strong> · {entry.action.replaceAll('_', ' ')} {entry.target_name && `· ${entry.target_name}`}<p className="text-muted-foreground">{entry.reason} · {new Date(entry.created_at).toLocaleString()}</p></li>)}</ol></details>
  </section>;
}
