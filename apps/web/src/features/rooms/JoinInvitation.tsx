import { useState } from 'react';
import { api, type Room } from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { invitationToken } from './invitationLink';

type Preview = { room_id: string; room_name: string; expires_at: string | null; remaining_uses: number | null; already_member: boolean };

export function EnterInvitation({ onClose, onChoose }: { onClose: () => void; onChoose: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  return <AppDialog open className="max-h-[calc(100dvh-2rem)] overflow-y-auto" onOpenChange={(open) => { if (!open) onClose(); }} title="Join with an invitation" description="Paste a BetterComms invitation link to review it before joining.">
    <form className="mt-5 space-y-4" onSubmit={(event) => {
      event.preventDefault();
      const token = invitationToken(value);
      if (!token) { setError('Paste a valid BetterComms invitation link.'); return; }
      onChoose(token);
    }}>
      <label className="block text-sm font-medium">Invitation link<Input className="mt-2" value={value} onChange={(event) => { setValue(event.target.value); setError(''); }} autoComplete="off" maxLength={2048} required /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit">Review invitation</Button></div>
    </form>
  </AppDialog>;
}

export default function JoinInvitation({ token, onClose, onJoined }: { token: string; onClose: () => void; onJoined: (room: Room) => Promise<void> | void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signalForRequest = useLifetimeSignal();
  useMountEffect(() => {
    const controller = new AbortController();
    void api<{ invite: Preview }>('/invites/' + encodeURIComponent(token), undefined, undefined, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setPreview(result.invite); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  });
  async function join() {
    const signal = signalForRequest();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ room: Room }>('/invites/' + encodeURIComponent(token) + '/join', {}, 'POST', signal);
      signal.throwIfAborted();
      await onJoined(result.room);
    } catch (failure) { if (!signal.aborted) setError(errorMessage(failure)); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return <AppDialog open className="max-h-[calc(100dvh-2rem)] overflow-y-auto" onOpenChange={(open) => { if (!open && !busy) onClose(); }} title="Room invitation" description="Review the room and choose whether to join.">
    <div className="mt-5 space-y-4">
      {loading && <p role="status" className="text-sm text-muted-foreground">Checking invitation…</p>}
      {preview && <div className="rounded-xl border p-4">
        <strong className="block break-words">{preview.room_name}</strong>
        <p className="mt-2 text-sm text-muted-foreground">{preview.already_member ? 'You already belong to this room.' : 'Joining gives you access to this room and its message history.'}</p>
        {preview.expires_at && <p className="mt-2 text-xs text-muted-foreground">Expires {new Date(preview.expires_at).toLocaleString()}</p>}
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={loading || !preview || busy} onClick={() => void join()}>{busy ? 'Joining…' : preview?.already_member ? 'Open room' : 'Join room'}</Button></div>
    </div>
  </AppDialog>;
}
