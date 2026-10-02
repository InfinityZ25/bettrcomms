import { useState, useSyncExternalStore } from 'react';
import { Check, LogOut, Settings2, Trash2, UserPlus } from 'lucide-react';
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
import { notificationSnapshot, setRoomNotificationMode, subscribeNotifications, type NotificationMode } from '@/features/chat/notificationSettings';

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
 * Direct conversations only expose notification choices.
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
  const notifications = useSyncExternalStore(subscribeNotifications, notificationSnapshot);

  const channel = (room.kind ?? 'channel') === 'channel';
  const group = room.kind === 'group';
  const owner = Boolean(user && room.owner_id === user.id);
  const label = roomLabel(room);

  if (!user) return <>{children}</>;

  const chooseNotifications = (mode: NotificationMode) => {
    void setRoomNotificationMode(room.id, mode).catch((error) => onError(errorMessage(error)));
  };

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
          <ContextMenuGroup>
            <ContextMenuLabel>Message notifications</ContextMenuLabel>
            {(['all', 'mentions', 'mute'] as NotificationMode[]).map((mode) => (
              <ContextMenuItem key={mode} onClick={() => chooseNotifications(mode)}>
                {notifications.rooms[room.id] === mode || (!notifications.rooms[room.id] && mode === 'all') ? <Check size={15} /> : <span className="inline-block w-[15px]" />}
                {mode === 'all' ? 'All messages' : mode === 'mentions' ? 'Mentions only' : 'Mute conversation'}
              </ContextMenuItem>
            ))}
          </ContextMenuGroup>
          {channel && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => onSettings(room)}><Settings2 /> Room settings…</ContextMenuItem>
              {owner && <ContextMenuItem onClick={() => onInvite(room)}><UserPlus /> Invite a friend…</ContextMenuItem>}
              <ContextMenuSeparator />
              {owner ? (
                <ContextMenuItem variant="destructive" onClick={() => setPending('delete')}><Trash2 /> Delete room</ContextMenuItem>
              ) : (
                <ContextMenuItem variant="destructive" onClick={() => setPending('leave')}><LogOut /> Leave room</ContextMenuItem>
              )}
            </>
          )}
          {group && <><ContextMenuSeparator /><ContextMenuItem onClick={() => onSettings(room)}><Settings2 /> Group info…</ContextMenuItem><ContextMenuItem variant="destructive" onClick={() => setPending('leave')}><LogOut /> Leave group</ContextMenuItem></>}
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
          if (!next && !busy) setPending(null);
        }}
        title={pending === 'leave' ? 'Leave this room?' : 'Delete this room?'}
        description={
          pending === 'leave'
            ? `You will leave ${label}. A friend has to invite you back.${group && owner ? ' Ownership passes to the next member.' : ''}`
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
