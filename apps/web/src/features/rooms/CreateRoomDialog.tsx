import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { api, type Room } from '@/api';

export default function CreateRoomDialog({
  open,
  onOpenChange,
  signedIn,
  busy,
  run,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signedIn: boolean;
  busy: boolean;
  run: (task: () => Promise<void>) => Promise<void>;
  onCreated: (room: Room) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Make a little room"
      description="A private place for your calls, screen shares, and conversations."
    >
      <form
        className="mt-6 flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await api<Room | { room: Room }>('/rooms', { name });
            await onCreated('room' in result ? result.room : result);
            onOpenChange(false);
            setName('');
          });
        }}
      >
        <label className="block text-xs font-medium text-foreground/80">
          Room name
          <input
            className="mt-2"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Friday night crew"
            maxLength={80}
            required
          />
        </label>
        {!signedIn && <p>Sign in before creating your first room.</p>}
        <Button disabled={!signedIn || busy}>
          Create room <ArrowRight size={16} />
        </Button>
      </form>
    </Dialog>
  );
}
