import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppDialog } from '@/components/app-dialog';
import FriendsPanel from './FriendsPanel';
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
  onSignIn,
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
  onSignIn: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Better with friends"
      description="Share your user ID with a friend so they can send you a request."
      className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
    >
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto overscroll-contain pr-1">
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
          <Button onClick={onSignIn}>Sign in to find your people</Button>
        )}
      </div>
    </AppDialog>
  );
}
