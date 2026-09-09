import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import FriendsPanel from './FriendsPanel';
import { signInWithWorkOS } from '@/features/auth/useSession';
import type { CallParticipant, Room, User } from '@/api';

export default function FriendsDialog({
  open,
  onOpenChange,
  user,
  room,
  callPresence,
  onlineUsers,
  refreshRevision,
  onError,
  onOpenRoom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User | null;
  room: Room | null;
  callPresence: Record<string, CallParticipant[]>;
  onlineUsers: Record<string, boolean>;
  refreshRevision: number;
  onError: (message: string) => void;
  onOpenRoom: (room: Room) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Better with friends"
      description="Share your user ID with a friend so they can send you a request."
    >
      <div className="mt-6 flex flex-col gap-5">
        {user ? (
          <>
            <label className="block text-xs font-medium text-foreground/80">
              Your user ID
              <div className="mt-2 flex items-center gap-2">
                <input className="text-xs" readOnly value={user.id} />
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Copy user ID"
                  onClick={() => {
                    void navigator.clipboard.writeText(user.id);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                </Button>
              </div>
            </label>
            <FriendsPanel
              callPresence={callPresence}
              onlineUsers={onlineUsers}
              refreshRevision={refreshRevision}
              user={user}
              room={room}
              onError={onError}
              onOpenRoom={(next) => {
                onOpenRoom(next);
                onOpenChange(false);
              }}
            />
          </>
        ) : (
          <Button onClick={signInWithWorkOS}>Sign in to find your people</Button>
        )}
      </div>
    </Dialog>
  );
}
