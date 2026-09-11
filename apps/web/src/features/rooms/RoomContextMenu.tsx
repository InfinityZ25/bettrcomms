import { useState } from 'react';
import { LogOut, Settings2, Trash2, UserPlus } from 'lucide-react';
import { api, type Room, type User } from '@/api';
import { errorMessage } from '@/lib/errors';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { roomLabel } from './RoomNavigation';

/**
 * Right-click a room.
 *
 * The menu offers what the API actually permits on that room and nothing else,
 * because an item that only ever returns 403 is worse than an item that is not
 * there. The server's own rules, read from the room store:
 *
 *   rename, delete   owner, and only on a channel
 *   add a member     owner, and only someone already an accepted friend
 *   leave            a channel member who is not the owner
 *
 * A direct conversation permits none of them, which is why it gets no menu at
 * all rather than a menu of refusals.
 */
export default function RoomContextMenu({
  room,
  user,
  onSettings,
  onInvite,
  onChanged,
  onError,
  children,
}: {
  room: Room;
  user: User | null;
  onSettings: (room: Room) => void;
  onInvite: (room: Room) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  children: React.ReactNode;
}) {
  const [pending, setPending] = useState<'delete' | 'leave' | null>(null);
  const [busy, setBusy] = useState(false);

  const channel = (room.kind ?? 'channel') === 'channel';
  const owner = Boolean(user && room.owner_id === user.id);
  const label = roomLabel(room);

  if (!channel || !user) return <>{children}</>;

  const confirmed = async () => {
    setBusy(true);
    try {
      // Leaving is removing yourself from the members, which is the only
      // member the server lets a non-owner remove.
      await api(
        pending === 'delete'
          ? '/rooms/' + room.id
          : '/rooms/' + room.id + '/members/' + user.id,
        undefined,
        'DELETE',
      );
      setPending(null);
      onChanged();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger className="w-full">{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuLabel className="truncate font-medium text-foreground">
              {label}
            </ContextMenuLabel>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onSettings(room)}>
            <Settings2 /> Room settings…
          </ContextMenuItem>
          {owner && (
            <ContextMenuItem onClick={() => onInvite(room)}>
              <UserPlus /> Invite a friend…
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {owner ? (
            <ContextMenuItem
              variant="destructive"
              onClick={() => setPending('delete')}
            >
              <Trash2 /> Delete room
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              variant="destructive"
              onClick={() => setPending('leave')}
            >
              <LogOut /> Leave room
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/*
        Both of these throw away something that cannot be fetched back — the
        room with its history, or your own place in it — so neither happens on
        a single click in a menu.
      */}
      <AppDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={pending === 'leave' ? 'Leave this room?' : 'Delete this room?'}
        description={
          pending === 'leave'
            ? `You will leave ${label}. A friend has to invite you back.`
            : `${label} and everything said in it goes for everyone. This cannot be undone.`
        }
      >
        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setPending(null)}
          >
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={confirmed}>
            {pending === 'leave' ? 'Leave room' : 'Delete room'}
          </Button>
        </div>
      </AppDialog>
    </>
  );
}
