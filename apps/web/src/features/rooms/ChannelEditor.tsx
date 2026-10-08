import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Hash,
  LockKeyhole,
  Megaphone,
  Trash2,
} from 'lucide-react';
import { api, type ChannelType, type Room } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { errorMessage } from '@/lib/errors';
import ChannelAccessEditor from './ChannelAccessEditor';
import type { CustomRole } from './channelPermissions';

export default function ChannelEditor({
  communityId,
  room,
  index,
  channels,
  editable,
  locked,
  beginChange,
  endChange,
  onChanged,
  onError,
  roles,
}: {
  communityId: string;
  room: Room;
  index: number;
  channels: Room[];
  editable: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  locked: boolean;
  beginChange: () => boolean;
  endChange: () => void;
  roles: CustomRole[];
}) {
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic ?? '');
  const [type, setType] = useState<ChannelType>(room.channel_type ?? 'hybrid');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmType, setConfirmType] = useState(false);
  const [editingAccess, setEditingAccess] = useState(false);
  const signalForRequest = useLifetimeSignal();
  async function run(task: (signal: AbortSignal) => Promise<unknown>) {
    if (busy || !beginChange()) return;
    const signal = signalForRequest();
    setBusy(true);
    try {
      await task(signal);
      if (!signal.aborted) {
        setRemoving(false);
        setConfirmType(false);
        await onChanged();
      }
    } catch (failure) {
      if (!signal.aborted) onError(errorMessage(failure));
    } finally {
      endChange();
      if (!signal.aborted) setBusy(false);
    }
  }
  function move(direction: -1 | 1) {
    const ids = channels.map((channel) => channel.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    void run((signal) =>
      api(
        `/communities/${communityId}/channels/reorder`,
        { channel_ids: ids },
        'POST',
        signal,
      ),
    );
  }
  const changed =
    name.trim() !== room.name ||
    topic.trim() !== (room.topic ?? '') ||
    type !== room.channel_type;
  const disabled = busy || locked;
  return (
    <article className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">
          {room.channel_type === 'announcement' ? (
            <Megaphone size={17} />
          ) : (
            <Hash size={17} />
          )}
        </span>
        <h4 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {room.name}
        </h4>
        {room.is_private && (
          <LockKeyhole
            size={14}
            aria-label="Private channel"
            className="text-muted-foreground"
          />
        )}
        {editable && (
          <>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Manage access to ${room.name}`}
              disabled={disabled}
              onClick={() => setEditingAccess(true)}
            >
              <LockKeyhole size={15} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Move ${room.name} up`}
              disabled={disabled || index === 0}
              onClick={() => move(-1)}
            >
              <ArrowUp size={15} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Move ${room.name} down`}
              disabled={disabled || index === channels.length - 1}
              onClick={() => move(1)}
            >
              <ArrowDown size={15} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Delete ${room.name}`}
              disabled={disabled || channels.length === 1}
              title={
                channels.length === 1
                  ? 'A room needs at least one channel'
                  : undefined
              }
              onClick={() => setRemoving(true)}
            >
              <Trash2 size={15} />
            </Button>
          </>
        )}
      </div>
      {editable ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              type === 'announcement' &&
              room.channel_type !== type &&
              !confirmType
            ) {
              setConfirmType(true);
              return;
            }
            void run((signal) =>
              api(
                `/communities/${communityId}/channels/${room.id}`,
                { name: name.trim(), topic: topic.trim(), channel_type: type },
                'PATCH',
                signal,
              ),
            );
          }}
        >
          <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
            <label className="space-y-1 text-xs">
              Name
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                required
                disabled={disabled}
              />
            </label>
            <label className="space-y-1 text-xs">
              Type
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={type}
                onChange={(event) => {
                  setType(event.target.value as ChannelType);
                  setConfirmType(false);
                }}
                disabled={disabled}
              >
                <option value="hybrid">Text and voice</option>
                <option value="announcement">Announcements</option>
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-xs">
            Topic
            <Input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              maxLength={500}
              disabled={disabled}
            />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            {type === 'hybrid'
              ? 'Text and voice share this channel. Access settings control who can view, post or join.'
              : 'Only the owner and admins publish. Voice is disabled. Access settings control who can read.'}
          </p>
          {confirmType && (
            <p role="status" className="text-xs text-destructive">
              Switching to announcements stops active voice and limits posting.
              Message history stays available.
            </p>
          )}
          <Button
            size="sm"
            type="submit"
            disabled={disabled || !name.trim() || !changed}
          >
            {confirmType ? 'Confirm announcement channel' : 'Save channel'}
          </Button>
        </form>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          {room.topic ||
            (room.channel_type === 'announcement'
              ? 'Announcements · no voice'
              : 'Text and voice')}
        </p>
      )}
      {removing && (
        <div className="rounded-lg border border-destructive/30 p-3 text-sm">
          <p>
            Delete #{room.name} and its messages for everyone? This cannot be
            undone.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={() =>
                void run((signal) =>
                  api(
                    `/communities/${communityId}/channels/${room.id}`,
                    undefined,
                    'DELETE',
                    signal,
                  ),
                )
              }
            >
              Delete channel permanently
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => setRemoving(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {editingAccess && (
        <ChannelAccessEditor
          communityId={communityId}
          room={room}
          roles={roles}
          onClose={() => setEditingAccess(false)}
          onChanged={onChanged}
        />
      )}
    </article>
  );
}
