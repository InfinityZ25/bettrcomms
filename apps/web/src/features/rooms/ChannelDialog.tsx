import { useState } from 'react';
import { Hash, Megaphone } from 'lucide-react';
import { api, type ChannelType, type Room } from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { errorMessage } from '@/lib/errors';

export default function ChannelDialog({
  communityId,
  communityName,
  onClose,
  onCreated,
}: {
  communityId: string;
  communityName: string;
  onClose: () => void;
  onCreated: (room: Room) => void;
}) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [type, setType] = useState<ChannelType>('hybrid');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signalForRequest = useLifetimeSignal();
  async function create() {
    if (busy) return;
    const signal = signalForRequest();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ room: Room }>(
        `/communities/${communityId}/channels`,
        {
          name: name.trim(),
          topic: topic.trim(),
          channel_type: type,
        },
        'POST',
        signal,
      );
      if (!signal.aborted) {
        onCreated(result.room);
        onClose();
      }
    } catch (failure) {
      if (!signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Create a channel"
      description={`A new place inside ${communityName}.`}
    >
      <form
        className="mt-5 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="block text-sm">
          Channel name
          <Input
            className="mt-2"
            autoFocus
            required
            maxLength={80}
            placeholder="weekend-plans"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </label>
        <label className="block text-sm">
          Topic <span className="text-muted-foreground">(optional)</span>
          <Input
            className="mt-2"
            maxLength={500}
            placeholder="What happens here?"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            disabled={busy}
          />
        </label>
        <fieldset className="space-y-2" disabled={busy}>
          <legend className="mb-2 text-sm font-medium">Channel type</legend>
          {(['hybrid', 'announcement'] as const).map((value) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${type === value ? 'border-primary bg-primary/5' : 'border-border'}`}
            >
              <input
                className="mt-1"
                type="radio"
                name="channel-type"
                value={value}
                checked={type === value}
                onChange={() => setType(value)}
              />
              {value === 'hybrid' ? (
                <Hash className="mt-0.5 shrink-0" size={18} />
              ) : (
                <Megaphone className="mt-0.5 shrink-0" size={18} />
              )}
              <span>
                <strong className="block text-sm">
                  {value === 'hybrid' ? 'Text and voice' : 'Announcements'}
                </strong>
                <span className="text-xs leading-5 text-muted-foreground">
                  {value === 'hybrid'
                    ? 'Chat, share files and join voice in the same channel.'
                    : 'Only owners and admins publish. Everyone can read. No voice.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create channel'}
          </Button>
        </div>
      </form>
    </AppDialog>
  );
}
