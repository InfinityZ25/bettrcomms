import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppDialog } from '@/components/app-dialog';
import { Input } from '@/components/ui/input';
import { api, type Community, type Room } from '@/api';

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
  const [description, setDescription] = useState('');
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Make room for your friends"
      description="Start with #general for text and voice. Add more channels and manage roles whenever you need them."
    >
      <form
        className="mt-6 flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await api<{ community: Community }>('/communities', {
              name: name.trim(),
              description: description.trim(),
            });
            const channel = result.community.channels[0];
            if (!channel)
              throw new Error(
                'The room was created without a channel. Refresh your rooms.',
              );
            await onCreated(channel);
            onOpenChange(false);
            setName('');
            setDescription('');
          });
        }}
      >
        <label className="block text-xs font-medium text-foreground/80">
          Room name
          <Input
            className="mt-2"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Friday night crew"
            maxLength={80}
            required
          />
        </label>
        <label className="block text-xs font-medium text-foreground/80">
          Description <span className="text-muted-foreground">(optional)</span>
          <Input
            className="mt-2"
            maxLength={500}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Your place to hang out"
          />
        </label>
        {!signedIn && <p>Sign in before creating your first room.</p>}
        {/*
          The submit type below is not optional. The shared Button renders the
          Base UI button primitive, which defaults every button it draws to
          type="button" — inert inside a form. Without it the click does nothing
          at all: no request, no error, no closed dialog.
        */}
        <Button type="submit" disabled={!signedIn || busy}>
          Create room <ArrowRight size={16} />
        </Button>
      </form>
    </AppDialog>
  );
}
