import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { Smile, X } from 'lucide-react';
import type { CustomStatus, User } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import EmojiDialog from '@/features/chat/EmojiDialog';
import { customStatusSnapshot, effectiveCustomStatus, receiveCustomStatus, saveCustomStatus, subscribeCustomStatus } from './customStatusStore';

type Expiry = 'keep' | '30m' | '1h' | '4h' | 'today' | 'never';
export function statusExpiry(preset: Expiry, previous?: string | null, now = new Date()): string | null {
  if (preset === 'keep') return previous ?? null;
  if (preset === 'never') return null;
  if (preset === 'today') { const end = new Date(now); end.setHours(23, 59, 59, 999); return end.toISOString(); }
  return new Date(now.getTime() + ({ '30m': 30, '1h': 60, '4h': 240 }[preset]) * 60_000).toISOString();
}
export function CustomStatusText({ userId, status, version = 0 }: { userId: string; status?: CustomStatus; version?: number }) {
  return <StatusText key={`${userId}:${version}:${status?.expires_at ?? ''}:${status?.text ?? ''}:${status?.emoji ?? ''}`} userId={userId} status={status} version={version} />;
}
function StatusText({ userId, status, version }: { userId: string; status?: CustomStatus; version: number }) {
  const snapshot = useSyncExternalStore(subscribeCustomStatus, customStatusSnapshot);
  useMountEffect(() => { if (status) receiveCustomStatus({ user_id: userId, status, version }); });
  const cached = snapshot.entries[userId];
  const visible = effectiveCustomStatus(cached && cached.version >= version ? cached.status : status);
  return visible.text || visible.emoji ? <span className="block truncate text-xs text-muted-foreground" title={`${visible.emoji} ${visible.text}`.trim()}>{visible.emoji && <span aria-hidden="true">{visible.emoji} </span>}{visible.text}</span> : null;
}
export default function CustomStatusSettings({ user }: { user: User }) {
  const snapshot = useSyncExternalStore(subscribeCustomStatus, customStatusSnapshot);
  const current = effectiveCustomStatus(snapshot.entries[user.id]?.status ?? user.custom_status);
  return <StatusEditor key={user.id} user={user} current={current} />;
}
function StatusEditor({ user, current }: { user: User; current: CustomStatus }) {
  const snapshot = useSyncExternalStore(subscribeCustomStatus, customStatusSnapshot);
  const [draft, setDraft] = useState<{ status: CustomStatus; baseline: CustomStatus } | null>(null);
  const [expiry, setExpiry] = useState<Expiry>('keep');
  const [picker, setPicker] = useState(false);
  const busy = snapshot.userId !== user.id || snapshot.busy;
  const text = draft?.status.text ?? current.text;
  const emoji = draft?.status.emoji ?? current.emoji;
  const dirty = text !== current.text || emoji !== current.emoji || expiry !== 'keep';
  const changedElsewhere = draft && JSON.stringify(draft.baseline) !== JSON.stringify(current);
  function edit(patch: Partial<CustomStatus>) { setDraft((previous) => ({ baseline: previous?.baseline ?? current, status: { ...(previous?.status ?? current), ...patch } })); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!busy && dirty && await saveCustomStatus({ text: text.trim(), emoji, expires_at: statusExpiry(expiry, current.expires_at) })) { setDraft(null); setExpiry('keep'); }
  }
  return <form className="space-y-4" onSubmit={save}>
    <p className="text-xs leading-5 text-muted-foreground">Share what you are up to. This appears on your profile and friends list and is independent of availability.</p>
    <div className="flex items-start gap-2">
      <Button type="button" variant="outline" size="icon" aria-label="Choose status emoji" disabled={busy} onClick={() => setPicker(true)}>{emoji || <Smile size={18} />}</Button>
      <div className="min-w-0 flex-1"><label htmlFor="custom-status-text" className="sr-only">Custom status</label><Input id="custom-status-text" value={text} maxLength={100} disabled={busy} placeholder="What are you up to?" onChange={(event) => edit({ text: event.target.value })} /><p className="mt-1 text-right text-xs text-muted-foreground">{[...text].length}/100</p></div>
      {emoji && <Button type="button" variant="ghost" size="icon" aria-label="Remove status emoji" disabled={busy} onClick={() => edit({ emoji: '' })}><X size={14} /></Button>}
    </div>
    <label className="flex flex-wrap items-center justify-between gap-2 text-xs">Clear status<select aria-label="Clear custom status after" className="rounded-lg border bg-background px-3 py-2" value={expiry} disabled={busy} onChange={(event) => setExpiry(event.target.value as Expiry)}><option value="keep">{current.expires_at ? `Keep expiry (${new Date(current.expires_at).toLocaleString()})` : 'Never'}</option><option value="30m">After 30 minutes</option><option value="1h">After 1 hour</option><option value="4h">After 4 hours</option><option value="today">At the end of today</option><option value="never">Never</option></select></label>
    {changedElsewhere && <p className="text-xs text-muted-foreground">Your status changed on another device. <button type="button" disabled={busy} className="underline" onClick={() => { setDraft(null); setExpiry('keep'); }}>Load the current status</button> or save your edits.</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" type="submit" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save status'}</Button>{dirty && <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => { setDraft(null); setExpiry('keep'); }}>Discard status changes</Button>}{(current.text || current.emoji) && <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => { void saveCustomStatus({ text: '', emoji: '', expires_at: null }).then((saved) => { if (saved) { setDraft(null); setExpiry('keep'); } }); }}>Clear status</Button>}</div>
    {snapshot.error && <p role="alert" className="text-xs text-destructive">{snapshot.error}</p>}
    {picker && <EmojiDialog onSelect={(value) => { edit({ emoji: value }); setPicker(false); }} onClose={() => setPicker(false)} />}
  </form>;
}
