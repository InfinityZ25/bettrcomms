import { useState, useSyncExternalStore } from 'react';
import {
  ChevronDown,
  Hash,
  Headphones,
  Megaphone,
  Plus,
  Settings2,
} from 'lucide-react';
import type { CallParticipant, Room, User } from '@/api';
import { Button } from '@/components/ui/button';
import {
  activitySnapshot,
  subscribeActivity,
  subscribeUnread,
  unreadSnapshot,
} from '@/features/chat/messageStore';
import { openUserProfile } from '@/features/settings/ProfileDialog';
import { cn } from '@/lib/utils';
import ChannelDialog from './ChannelDialog';
import RoomContextMenu from './RoomContextMenu';

export default function CommunityNavigation({
  rooms,
  user,
  selected,
  presence,
  known,
  onSelect,
  onSettings,
  onInvite,
  onChanged,
  onError,
  mobile = false,
}: {
  rooms: Room[];
  user: User | null;
  selected?: string;
  presence: Record<string, CallParticipant[]>;
  known: boolean;
  onSelect: (room: Room) => void;
  onSettings: (room: Room) => void;
  onInvite: (room: Room) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  mobile?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState<Room | null>(null);
  const unread = useSyncExternalStore(subscribeUnread, unreadSnapshot);
  const activity = useSyncExternalStore(subscribeActivity, activitySnapshot);
  const groups = new Map<string, Room[]>();
  for (const room of rooms) {
    const id = room.community_id ?? room.id;
    const channels = groups.get(id) ?? [];
    channels.push(room);
    groups.set(id, channels);
  }
  const communities = [...groups.entries()].sort(([, a], [, b]) =>
    (a[0].community_name ?? a[0].name).localeCompare(
      b[0].community_name ?? b[0].name,
    ),
  );
  return (
    <div className={cn('space-y-4 px-2 py-2', mobile && 'space-y-5')}>
      {communities.map(([id, channels]) => {
        const ordered = [...channels].sort(
          (a, b) =>
            (a.position ?? 0) - (b.position ?? 0) ||
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id),
        );
        const first = ordered[0];
        const name = first.community_name ?? first.name;
        const expanded = !collapsed.has(id);
        const count = channels.reduce(
          (sum, channel) => sum + (unread[channel.id]?.unread ?? 0),
          0,
        );
        return (
          <section key={id} aria-label={`${name} channels`}>
            <div className="mb-1 flex items-center gap-1">
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name} channels`}
                className="flex min-h-10 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
              >
                <ChevronDown
                  size={15}
                  className={cn(
                    'shrink-0 transition-transform motion-reduce:transition-none',
                    !expanded && '-rotate-90',
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {name}
                </span>
                {!expanded && count > 0 && (
                  <span
                    className="text-xs text-primary"
                    aria-label={`${count} unread messages`}
                  >
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </button>
              {user && first.permissions?.manage_channels && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 phone:size-11"
                  aria-label={`Create channel in ${name}`}
                  onClick={() => setCreating(first)}
                >
                  <Plus size={15} />
                </Button>
              )}
              {user && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 phone:size-11"
                  aria-label={`${name} room settings`}
                  onClick={() => onSettings(first)}
                >
                  <Settings2 size={15} />
                </Button>
              )}
            </div>
            {expanded && (
              <ul className="space-y-1" aria-label={`${name} channel list`}>
                {ordered.map((channel) => {
                  const callers = presence[channel.id] ?? [];
                  const summary = unread[channel.id];
                  const announcement = channel.channel_type === 'announcement';
                  const recent = activity[channel.id];
                  return (
                    <li key={channel.id}>
                      <RoomContextMenu
                        room={channel}
                        user={user}
                        onSettings={onSettings}
                        onInvite={onInvite}
                        onChanged={onChanged}
                        onError={onError}
                      >
                        <button
                          type="button"
                          aria-current={
                            selected === channel.id ? 'page' : undefined
                          }
                          title={channel.topic || undefined}
                          aria-label={channel.name}
                          aria-description={`${announcement ? 'Announcements' : 'Text and voice'}${summary?.unread ? `, ${summary.unread} unread messages` : ''}`}
                          className={cn(
                            'flex min-h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                            mobile && 'min-h-14',
                            selected === channel.id && 'bg-muted font-semibold',
                            summary?.unread && 'text-foreground',
                            !summary?.unread &&
                              selected !== channel.id &&
                              'text-muted-foreground',
                          )}
                          onClick={() => onSelect(channel)}
                        >
                          {announcement ? (
                            <Megaphone size={17} className="shrink-0" />
                          ) : (
                            <Hash size={18} className="shrink-0" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {channel.name}
                            </span>
                            {mobile && (
                              <span className="block truncate text-xs font-normal text-muted-foreground">
                                {channel.topic ||
                                  (announcement
                                    ? 'Announcements'
                                    : 'Text and voice together')}
                              </span>
                            )}
                          </span>
                          {(summary?.unread ?? 0) > 0 ? (
                            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[0.65rem] font-semibold text-primary-foreground">
                              {summary?.mentions ? '@ ' : ''}
                              {summary!.unread > 99 ? '99+' : summary!.unread}
                            </span>
                          ) : (
                            recent && (
                              <span className="sr-only">Recent activity</span>
                            )
                          )}
                          {known && !announcement && callers.length > 0 && (
                            <span
                              className="flex items-center gap-1 text-xs text-primary"
                              aria-label={`${callers.length} in voice`}
                            >
                              <Headphones size={13} />
                              {callers.length}
                            </span>
                          )}
                        </button>
                      </RoomContextMenu>
                      {known && !announcement && callers.length > 0 && (
                        <ul
                          className="my-1 ml-6 border-l pl-3"
                          aria-label={`${channel.name} call participants`}
                        >
                          {callers.map((person) => (
                            <li key={person.user_id}>
                              <button
                                type="button"
                                className="min-h-7 max-w-full truncate text-left text-xs text-muted-foreground hover:underline"
                                onClick={() => openUserProfile(person.user_id)}
                              >
                                {person.name || 'Participant'}
                                {person.deafened ? (
                                  <span aria-label="Deafened"> · deafened</span>
                                ) : person.muted ? (
                                  <span aria-label="Muted"> · muted</span>
                                ) : (
                                  ''
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      {creating?.community_id && (
        <ChannelDialog
          key={creating.community_id}
          communityId={creating.community_id}
          communityName={creating.community_name ?? creating.name}
          onClose={() => setCreating(null)}
          onCreated={(channel) => {
            onChanged();
            onSelect(channel);
          }}
        />
      )}
    </div>
  );
}
