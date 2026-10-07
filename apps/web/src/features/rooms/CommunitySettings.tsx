import { useRef, useState } from 'react';
import { DoorOpen, Plus, Shield, Trash2, UserMinus } from 'lucide-react';
import {
  api,
  type Community,
  type CommunityRole,
  type Room,
  type RoomMember,
  type User,
} from '@/api';
import { AppDialog } from '@/components/app-dialog';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { useMountEffect } from '@/hooks/useMountEffect';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors';
import ChannelDialog from './ChannelDialog';
import ChannelEditor from './ChannelEditor';
import CommunityReports from './CommunityReports';
import ModerationSettings from './ModerationSettings';
import RoomInviteLinks from './RoomInviteLinks';
import { canManageRole, canModerateRole } from './communityRoles';
import {
  callPresenceSnapshot,
  subscribeCallPresence,
} from '@/features/call/useCallPresence';

type Section = 'overview' | 'channels' | 'members' | 'moderation';
type Confirmation =
  | { kind: 'remove'; member: RoomMember }
  | { kind: 'transfer'; member: RoomMember }
  | { kind: 'delete' | 'leave' };

export default function CommunitySettings({
  room,
  user,
  onClose,
  onChanged,
}: {
  room: Room;
  user: User;
  onClose: () => void;
  onChanged: () => void;
}) {
  const id = room.community_id!;
  const [community, setCommunity] = useState<Community | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [friends, setFriends] = useState<User[]>([]);
  const [name, setName] = useState(room.community_name ?? room.name);
  const [description, setDescription] = useState('');
  const [section, setSection] = useState<Section>('overview');
  const [moderationChannel, setModerationChannel] = useState(room.id);
  const [creating, setCreating] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const signalForRequest = useLifetimeSignal();
  const loadGeneration = useRef(0);
  const draftInitialized = useRef(false);
  const channelMutation = useRef(false);
  const path = `/communities/${id}`;

  async function load(initial = false) {
    const signal = signalForRequest();
    const generation = ++loadGeneration.current;
    const [info, people, accepted] = await Promise.all([
      api<{ community: Community }>(path, undefined, 'GET', signal),
      api<{ members: RoomMember[] }>(
        `${path}/members`,
        undefined,
        'GET',
        signal,
      ),
      room.permissions?.manage_members
        ? api<{ friends: User[] }>('/friends', undefined, 'GET', signal)
        : Promise.resolve({ friends: [] }),
    ]);
    if (signal.aborted || generation !== loadGeneration.current) return;
    setCommunity(info.community);
    setMembers(people.members);
    setFriends(accepted.friends);
    if (initial || !draftInitialized.current) {
      draftInitialized.current = true;
      setName(info.community.name);
      setDescription(info.community.description);
    }
  }
  async function initialLoad() {
    const signal = signalForRequest();
    setLoading(true);
    setError('');
    try {
      await load(true);
    } catch (failure) {
      if (!signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }
  useMountEffect(() => {
    void initialLoad();
    const state = callPresenceSnapshot();
    let revision = `${state.roomsRevision}:${state.syncRevision}:${state.friendsRevision}`;
    return subscribeCallPresence(() => {
      const current = callPresenceSnapshot();
      const next = `${current.roomsRevision}:${current.syncRevision}:${current.friendsRevision}`;
      if (revision === next) return;
      revision = next;
      void load().catch((failure) => {
        if (!signalForRequest().aborted) setError(errorMessage(failure));
      });
    });
  });

  async function action(
    task: (signal: AbortSignal) => Promise<unknown>,
    close = false,
  ) {
    if (busy) return;
    const signal = signalForRequest();
    setBusy(true);
    setError('');
    try {
      await task(signal);
      if (!signal.aborted) {
        setConfirmation(null);
        if (close) onClose();
        else await load();
        onChanged();
      }
    } catch (failure) {
      if (!signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  async function channelsChanged() {
    await load();
    onChanged();
  }
  function beginChannelChange() {
    if (channelMutation.current || busy) return false;
    channelMutation.current = true;
    setBusy(true);
    setError('');
    return true;
  }
  function endChannelChange() {
    channelMutation.current = false;
    setBusy(false);
  }
  const role = community?.role ?? room.role ?? 'member';
  const owner = role === 'owner';
  const administrator = owner || role === 'admin';
  const moderator = administrator || role === 'moderator';
  const channels = [...(community?.channels ?? [])].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id),
  );
  const selectedChannel =
    channels.find((channel) => channel.id === moderationChannel) ?? channels[0];
  const candidates = friends.filter(
    (friend) => !members.some((member) => member.user.id === friend.id),
  );
  const options: { value: Section; label: string }[] = [
    { value: 'overview', label: 'Room' },
    {
      value: 'channels',
      label: `Channels${channels.length ? ` · ${channels.length}` : ''}`,
    },
    {
      value: 'members',
      label: `Members${members.length ? ` · ${members.length}` : ''}`,
    },
    ...(moderator
      ? [{ value: 'moderation' as const, label: 'Moderation' }]
      : []),
  ];

  async function confirm() {
    if (!confirmation) return;
    const current = confirmation;
    if (current.kind === 'remove')
      await action((signal) =>
        api(
          `${path}/members/${current.member.user.id}`,
          undefined,
          'DELETE',
          signal,
        ),
      );
    else if (current.kind === 'transfer')
      await action((signal) =>
        api(
          `${path}/ownership`,
          { user_id: current.member.user.id },
          'POST',
          signal,
        ),
      );
    else if (current.kind === 'delete')
      await action((signal) => api(path, undefined, 'DELETE', signal), true);
    else
      await action(
        (signal) =>
          api(`${path}/members/${user.id}`, undefined, 'DELETE', signal),
        true,
      );
  }

  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={community?.name ?? name}
      description="Channels share one membership and one set of room roles."
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"
    >
      <div className="mt-3 space-y-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Shield size={14} />
          <span className="capitalize">Your role: {role}</span>
        </div>
        <nav
          className="flex flex-wrap gap-1 border-b pb-3"
          aria-label="Room settings sections"
        >
          {options.map((option) => (
            <Button
              key={option.value}
              variant={section === option.value ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={section === option.value}
              onClick={() => setSection(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </nav>
        {loading && (
          <p className="text-sm text-muted-foreground">
            Loading room settings…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
            {!community && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void initialLoad()}
              >
                Retry
              </Button>
            )}
          </p>
        )}
        {!loading && community && section === 'overview' && (
          <div className="space-y-5">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void action((signal) =>
                  api(
                    path,
                    { name: name.trim(), description: description.trim() },
                    'PATCH',
                    signal,
                  ),
                );
              }}
            >
              <label className="block space-y-2 text-sm">
                Room name
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={100}
                  required
                  disabled={!administrator || busy}
                />
              </label>
              <label className="block space-y-2 text-sm">
                Description
                <textarea
                  className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={500}
                  disabled={!administrator || busy}
                />
              </label>
              {administrator && (
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !name.trim() ||
                    (name.trim() === community.name &&
                      description.trim() === community.description)
                  }
                >
                  Save room
                </Button>
              )}
            </form>
            <div className="rounded-xl bg-muted/50 p-4 text-sm leading-6">
              <strong>One channel, text and voice.</strong>
              <p className="text-muted-foreground">
                Messages, files and voice live together in each channel.
                Announcement channels are reserved for updates from the owner
                and admins.
              </p>
            </div>
            {(selectedChannel?.permissions?.manage_invites ?? moderator) &&
              selectedChannel && (
                <RoomInviteLinks
                  key={selectedChannel.id}
                  roomId={selectedChannel.id}
                />
              )}
            <div className="border-t pt-4">
              {owner ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmation({ kind: 'delete' })}
                >
                  <Trash2 size={16} />
                  Delete room
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmation({ kind: 'leave' })}
                >
                  <DoorOpen size={16} />
                  Leave room
                </Button>
              )}
              {owner && (
                <p className="mt-2 text-xs text-muted-foreground">
                  To leave without deleting this room, transfer ownership in
                  Members first.
                </p>
              )}
            </div>
          </div>
        )}
        {!loading && community && section === 'channels' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs leading-5 text-muted-foreground">
                All channels share this room's members and roles.
              </p>
              {administrator && (
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus size={15} />
                  New channel
                </Button>
              )}
            </div>
            {channels.map((channel, index) => (
              <ChannelEditor
                key={`${channel.id}:${channel.name}:${channel.topic}:${channel.channel_type}`}
                communityId={id}
                room={channel}
                index={index}
                channels={channels}
                editable={channel.permissions?.manage_channels ?? administrator}
                locked={busy}
                beginChange={beginChannelChange}
                endChange={endChannelChange}
                onChanged={channelsChanged}
                onError={setError}
              />
            ))}
          </div>
        )}
        {!loading && community && section === 'members' && (
          <div className="space-y-5">
            <div className="rounded-xl bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
              <strong className="text-foreground">Owner</strong> controls
              ownership. <strong className="text-foreground">Admins</strong>{' '}
              manage the room and channels.{' '}
              <strong className="text-foreground">Moderators</strong> handle
              members, reports and invitations.{' '}
              <strong className="text-foreground">Members</strong> chat and join
              voice.
            </div>
            <ul className="divide-y">
              {members.map((member) => {
                const manage =
                  member.user.id !== user.id &&
                  canManageRole(role, member.role);
                const remove =
                  member.user.id !== user.id &&
                  canModerateRole(role, member.role);
                const assignable: CommunityRole[] = owner
                  ? ['admin', 'moderator', 'member']
                  : ['moderator', 'member'];
                return (
                  <li
                    key={member.user.id}
                    className="flex flex-wrap items-center gap-3 py-3"
                  >
                    <Avatar
                      name={member.user.name}
                      id={member.user.id}
                      src={member.user.avatar_url}
                    />
                    <span className="min-w-0 flex-1 text-sm">
                      <strong className="block truncate">
                        {member.user.name}
                        {member.user.id === user.id ? ' (you)' : ''}
                      </strong>
                      <small className="capitalize text-muted-foreground">
                        {member.role}
                      </small>
                    </span>
                    {manage && (
                      <label className="text-xs">
                        <span className="sr-only">
                          Role for {member.user.name}
                        </span>
                        <select
                          className="h-9 rounded-md border bg-background px-2 text-sm"
                          aria-label={`Role for ${member.user.name}`}
                          value={member.role}
                          disabled={busy}
                          onChange={(event) =>
                            void action((signal) =>
                              api(
                                `${path}/members/${member.user.id}/role`,
                                { role: event.target.value },
                                'PUT',
                                signal,
                              ),
                            )
                          }
                        >
                          {assignable.map((value) => (
                            <option key={value} value={value}>
                              {value[0].toUpperCase() + value.slice(1)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {owner && member.user.id !== user.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({ kind: 'transfer', member })
                        }
                      >
                        Transfer ownership
                      </Button>
                    )}
                    {remove && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={`Remove ${member.user.name} from room`}
                        onClick={() =>
                          setConfirmation({ kind: 'remove', member })
                        }
                      >
                        <UserMinus size={16} />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {(selectedChannel?.permissions?.manage_members ?? moderator) && (
              <section className="space-y-2 border-t pt-4">
                <h3 className="text-sm font-semibold">
                  Add an accepted friend
                </h3>
                {candidates.length ? (
                  <ul className="max-h-44 overflow-y-auto">
                    {candidates.map((friend) => (
                      <li
                        key={friend.id}
                        className="flex items-center justify-between gap-2 py-2 text-sm"
                      >
                        <span className="truncate">{friend.name}</span>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          aria-label={`Add ${friend.name} to ${community.name}`}
                          onClick={() =>
                            void action((signal) =>
                              api(
                                `${path}/members`,
                                { user_id: friend.id },
                                'POST',
                                signal,
                              ),
                            )
                          }
                        >
                          Add
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    All your accepted friends are already here.
                  </p>
                )}
              </section>
            )}
          </div>
        )}
        {!loading &&
          community &&
          section === 'moderation' &&
          moderator &&
          selectedChannel && (
            <div className="space-y-4">
              <label className="block space-y-2 text-sm">
                Channel
                <select
                  value={selectedChannel.id}
                  onChange={(event) => setModerationChannel(event.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3"
                >
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      #{channel.name}
                    </option>
                  ))}
                </select>
              </label>
              <ModerationSettings
                key={`${selectedChannel.id}:${role}`}
                room={selectedChannel}
                user={user}
                onChanged={onChanged}
              />
              <CommunityReports
                key={selectedChannel.id}
                roomId={selectedChannel.id}
                onChanged={onChanged}
              />
            </div>
          )}
        {confirmation && (
          <div
            className={cn(
              'rounded-xl border p-4 text-sm',
              confirmation.kind !== 'transfer' && 'border-destructive/30',
            )}
            role="alert"
          >
            <p>
              {confirmation.kind === 'remove'
                ? `Remove ${confirmation.member.user.name} from every channel in this room and end their active calls?`
                : confirmation.kind === 'transfer'
                  ? `Make ${confirmation.member.user.name} the owner? You will become an admin and lose ownership controls.`
                  : confirmation.kind === 'delete'
                    ? 'Delete this room, every channel and all their messages for everyone? This cannot be undone.'
                    : 'Leave every channel in this room? You will need a new invitation to come back.'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant={
                  confirmation.kind === 'transfer' ? 'default' : 'destructive'
                }
                disabled={busy}
                onClick={() => void confirm()}
              >
                {confirmation.kind === 'delete'
                  ? 'Delete room permanently'
                  : confirmation.kind === 'transfer'
                    ? 'Transfer ownership'
                    : confirmation.kind === 'remove'
                      ? 'Remove member'
                      : 'Leave room'}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
      {creating && community && (
        <ChannelDialog
          key={id}
          communityId={id}
          communityName={community.name}
          onClose={() => setCreating(false)}
          onCreated={() => {
            void channelsChanged().catch((failure) =>
              setError(errorMessage(failure)),
            );
          }}
        />
      )}
    </AppDialog>
  );
}
