import { useRef, useState } from 'react';
import { api, type Room, type User } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';
import { sessionExpired } from '@/features/auth/sessionEvents';
import { SettingBlock } from './SettingRow';
import { SettingsSection } from './SettingsSection';

type DeviceSession = { id: string; device_name: string; created_at: string; last_seen_at: string; expires_at: string; current: boolean };
const date = (value: string) => new Date(value).toLocaleString();

function TransferOwnership({ room, user, onTransferred }: { room: Room; user: User; onTransferred: () => void }) {
  const [members, setMembers] = useState<User[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  useMountEffect(() => {
    const request = new AbortController(); controller.current = request;
    api<{ members: { user: User }[] }>(`/rooms/${room.id}/members`, undefined, undefined, request.signal)
      .then((result) => { if (!request.signal.aborted) setMembers(result.members.map((member) => member.user).filter((member) => member.id !== user.id)); })
      .catch((failure) => { if (!request.signal.aborted) setError(errorMessage(failure)); });
    return () => request.abort();
  });
  const transfer = async () => {
    if (!target || !controller.current || busy) return;
    setBusy(true); setError('');
    try {
      await api(`/rooms/${room.id}/ownership`, { user_id: target }, 'POST', controller.current.signal);
      if (!controller.current.signal.aborted) onTransferred();
    } catch (failure) { if (!controller.current.signal.aborted) setError(errorMessage(failure)); }
    finally { if (!controller.current.signal.aborted) setBusy(false); }
  };
  return <div className="space-y-2 border-b border-border/50 py-3">
    <strong className="text-sm">{room.name}</strong>
    <div className="flex flex-wrap items-center gap-2">
      <select className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" aria-label={`New owner of ${room.name}`} value={target} onChange={(event) => setTarget(event.target.value)} disabled={busy}>
        <option value="">Choose a new owner</option>
        {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select>
      <Button variant="outline" disabled={!target || busy} onClick={() => void transfer()}>Transfer ownership</Button>
    </div>
    {!members.length && <p className="text-xs text-muted-foreground">Add another member in the channel first, or delete this channel in Room settings.</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

export default function AccountSettings({ user }: { user: User }) {
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [owned, setOwned] = useState<Room[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [email, setEmail] = useState('');
  const lifetime = useRef<AbortController | undefined>(undefined);
  const refresh = async (signal: AbortSignal) => {
    const [devices, rooms] = await Promise.all([api<{ sessions: DeviceSession[] }>('/me/sessions', undefined, undefined, signal), api<{ rooms: Room[] }>('/rooms', undefined, undefined, signal)]);
    if (!signal.aborted) { setSessions(devices.sessions); setOwned(rooms.rooms.filter((room) => room.kind === 'channel' && room.owner_id === user.id)); setLoaded(true); }
  };
  useMountEffect(() => {
    const request = new AbortController(); lifetime.current = request;
    void refresh(request.signal).catch((failure) => { if (!request.signal.aborted) setError(errorMessage(failure)); });
    return () => request.abort();
  });
  const act = async (operation: (signal: AbortSignal) => Promise<void>) => {
    const request = lifetime.current;
    if (!request || request.signal.aborted || busy) return;
    setBusy(true); setError('');
    try { await operation(request.signal); }
    catch (failure) { if (!request.signal.aborted) setError(errorMessage(failure)); }
    finally { if (!request.signal.aborted) setBusy(false); }
  };
  return <SettingsSection id="settings-account" title="Account and sessions">
    {error && <p role="alert" className="py-3 text-sm text-destructive">{error}</p>}
    <SettingBlock title="Signed-in devices" description="These are BetterComms sessions. Device descriptions are approximate; revoking a session signs out its windows and stops their calls.">
      {!loaded && !error && <p role="status" className="text-sm text-muted-foreground">Loading sessions…</p>}
      <ul className="divide-y divide-border/50">
        {sessions.map((session) => <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0 text-sm"><strong>{session.device_name}{session.current && ' · This session'}</strong><p className="mt-1 text-xs text-muted-foreground">Started {date(session.created_at)} · Last active {date(session.last_seen_at)}</p></div>
          <Button variant="outline" disabled={busy} onClick={() => void act(async (signal) => { await api(`/me/sessions/${session.id}`, undefined, 'DELETE', signal); if (session.current) sessionExpired(); else await refresh(signal); })}>{session.current ? 'Sign out here' : 'Revoke session'}</Button>
        </li>)}
      </ul>
      <Button variant="outline" disabled={busy || !sessions.some((session) => !session.current)} onClick={() => void act(async (signal) => { await api('/me/sessions/revoke-others', {}, 'POST', signal); await refresh(signal); })}>Sign out other devices</Button>
    </SettingBlock>
    <SettingBlock title="Channel ownership" description="Transfer channels you own before deleting your account. A transfer takes effect immediately and gives that member the channel controls.">
      {owned.map((room) => <TransferOwnership key={room.id} room={room} user={user} onTransferred={() => { if (lifetime.current) void act((signal) => refresh(signal)); }} />)}
      {loaded && !owned.length && <p className="text-sm text-muted-foreground">You do not own any channels.</p>}
    </SettingBlock>
    <SettingBlock title="Delete BetterComms account" description="Permanently remove your profile, contacts, sessions and personal content from BetterComms. Anonymous deleted-message and moderation references remain. Your WorkOS identity is separate; signing in later creates a new BetterComms account.">
      {!deleting ? <Button variant="destructive" disabled={!loaded || busy || owned.length > 0} onClick={() => setDeleting(true)}>Delete account…</Button> : <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void act(async (signal) => { await api('/me/account', { confirmation, email }, 'DELETE', signal); sessionExpired(); }); }}>
        <p className="text-sm font-medium text-destructive">This cannot be undone.</p>
        <label className="block space-y-1 text-sm"><span>Your account email</span><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" required /></label>
        <label className="block space-y-1 text-sm"><span>Type DELETE to confirm</span><Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" required /></label>
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => { setDeleting(false); setConfirmation(''); setEmail(''); }}>Cancel</Button><Button type="submit" variant="destructive" disabled={busy || confirmation !== 'DELETE' || email.trim().toLowerCase() !== user.email.toLowerCase()}>Permanently delete account</Button></div>
      </form>}
    </SettingBlock>
  </SettingsSection>;
}
