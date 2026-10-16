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
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import {
  activitySnapshot,
  subscribeActivity,
  subscribeUnread,
  unreadSnapshot,
} from '@/features/chat/messageStore';
import { openUserProfile } from '@/features/settings/ProfileDialog';
import { hueFor } from '@/features/settings/blobatarIdentity';
import { cn } from '@/lib/utils';
import ChannelDialog from './ChannelDialog';
import RoomContextMenu from './RoomContextMenu';

/**
 * A community's tile, until communities have icons of their own: its first
 * letter on a gradient whose hue is drawn from the community's id, by the same
 * hash that colours people's faces, so it never changes and neighbours differ.
 * The ink letter keeps its contrast on every hue the wheel can produce.
 */
const monogram = (name: string) =>
  (Array.from(name.trim())[0] ?? '#').toLocaleUpperCase();
const monogramStyle = (id: string) => {
  const hue = hueFor(id);
  return {
    backgroundImage: `linear-gradient(135deg, oklch(0.84 0.12 ${hue}) 0%, oklch(0.72 0.15 ${(hue + 38) % 360}) 100%)`,
  };
};

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
    <div className={cn('space-y-4 px-2 py-1.5', mobile && 'space-y-6')}>
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
            {/*
              With a mouse the two actions float over the end of the header
              and fade in while the pointer or focus is on it, so the name
              gets the whole row the rest of the time. Touch keeps them in the
              row, always shown, because nothing there can hover.
            */}
            <div className="group/community relative mb-1.5 flex items-center gap-0.5">
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name} channels`}
                className={cn(
                  'group/header flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-xl px-1 text-left transition-[background-color,padding] duration-150 hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-ring',
                  mobile && 'min-h-12 gap-2.5 px-1.5',
                  !mobile &&
                    user &&
                    (first.permissions?.manage_channels
                      ? 'pointer-fine:group-focus-within/community:pr-[3.75rem] pointer-fine:group-hover/community:pr-[3.75rem]'
                      : 'pointer-fine:group-focus-within/community:pr-8 pointer-fine:group-hover/community:pr-8'),
                  !mobile &&
                    'phone:group-focus-within/community:pr-1 phone:group-hover/community:pr-1',
                )}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-[8px] font-heading text-xs leading-none font-extrabold text-[oklch(0.2_0.03_274)] shadow-[inset_0_1px_0_oklch(1_0_0/0.4),0_3px_10px_-3px_oklch(0_0_0/0.45)] transition-[border-radius] duration-200 ease-out group-hover/header:rounded-[6px]',
                    mobile &&
                      'size-9 rounded-[12px] text-base group-hover/header:rounded-[10px]',
                  )}
                  style={monogramStyle(id)}
                >
                  {monogram(name)}
                </span>
                <ChevronDown
                  size={15}
                  className={cn(
                    'order-1 -ml-1 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none group-hover/header:text-foreground',
                    !expanded && '-rotate-90',
                  )}
                />
                <span
                  className={cn(
                    'min-w-0 truncate text-sm font-bold',
                    mobile && 'text-base',
                  )}
                >
                  {name}
                </span>
                {!expanded && count > 0 && (
                  <span
                    className="order-2 ml-auto grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[0.6875rem] leading-none font-bold text-primary-foreground tabular-nums animate-bc-pop"
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
                  className={cn(
                    'size-7 rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground dark:hover:bg-sidebar-accent phone:size-11',
                    !mobile &&
                      'transition-[opacity,color,background-color] pointer-fine:absolute pointer-fine:top-1.5 pointer-fine:right-[2.0625rem] pointer-fine:opacity-0 pointer-fine:group-focus-within/community:opacity-100 pointer-fine:group-hover/community:opacity-100 phone:static phone:opacity-100',
                  )}
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
                  className={cn(
                    'size-7 rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground dark:hover:bg-sidebar-accent phone:size-11',
                    !mobile &&
                      'transition-[opacity,color,background-color] pointer-fine:absolute pointer-fine:top-1.5 pointer-fine:right-1 pointer-fine:opacity-0 pointer-fine:group-focus-within/community:opacity-100 pointer-fine:group-hover/community:opacity-100 phone:static phone:opacity-100',
                  )}
                  aria-label={`${name} room settings`}
                  onClick={() => onSettings(first)}
                >
                  <Settings2 size={15} />
                </Button>
              )}
            </div>
            {expanded && (
              <ul
                className={cn('space-y-0.5', mobile && 'space-y-1')}
                aria-label={`${name} channel list`}
              >
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
                            // The bar on the inner edge: tall and lime for the
                            // channel you are in, a short stub for unread ones.
                            'group/channel relative flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm font-medium transition-colors hover:bg-sidebar-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                            'before:pointer-events-none before:absolute before:top-1/2 before:left-0 before:h-0 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-foreground before:transition-[height] before:duration-200 before:ease-out',
                            mobile && 'min-h-14 rounded-2xl px-3',
                            selected === channel.id &&
                              'bg-sidebar-accent font-semibold text-foreground before:h-5 before:bg-primary hover:bg-sidebar-accent',
                            summary?.unread && 'font-semibold text-foreground',
                            summary?.unread &&
                              selected !== channel.id &&
                              'before:h-2',
                            !summary?.unread &&
                              selected !== channel.id &&
                              'text-muted-foreground',
                          )}
                          onClick={() => onSelect(channel)}
                        >
                          {announcement ? (
                            <Megaphone
                              size={17}
                              className={cn(
                                'shrink-0 text-muted-foreground transition-colors group-hover/channel:text-foreground',
                                selected === channel.id &&
                                  'text-primary group-hover/channel:text-primary',
                              )}
                            />
                          ) : (
                            <Hash
                              size={18}
                              className={cn(
                                'shrink-0 text-muted-foreground transition-colors group-hover/channel:text-foreground',
                                selected === channel.id &&
                                  'text-primary group-hover/channel:text-primary',
                              )}
                            />
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
                            <span
                              className={cn(
                                'grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[0.6875rem] leading-none font-bold text-primary-foreground tabular-nums animate-bc-pop',
                                summary?.mentions && 'bg-dnd text-white',
                              )}
                            >
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
                              className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-online/12 px-1.5 text-[0.6875rem] font-semibold text-foreground tabular-nums dark:text-online"
                              aria-label={`${callers.length} in voice`}
                            >
                              <span
                                aria-hidden="true"
                                className="size-1.5 rounded-full bg-online animate-bc-pulse"
                              />
                              <Headphones size={13} />
                              {callers.length}
                            </span>
                          )}
                        </button>
                      </RoomContextMenu>
                      {known && !announcement && callers.length > 0 && (
                        <ul
                          className={cn(
                            'my-1 ml-[1.1875rem] space-y-px border-l-2 border-online/25 pl-2',
                            mobile && 'ml-6 pl-3',
                          )}
                          aria-label={`${channel.name} call participants`}
                        >
                          {callers.map((person) => (
                            <li key={person.user_id}>
                              <button
                                type="button"
                                className={cn(
                                  'flex min-h-7 w-full max-w-full items-center gap-2 rounded-lg px-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground',
                                  mobile && 'min-h-9 text-sm',
                                )}
                                onClick={() => openUserProfile(person.user_id)}
                              >
                                {/* Their face, ringed green while their microphone is open. */}
                                <span aria-hidden="true" className="shrink-0">
                                  <Avatar
                                    name={person.name || 'Participant'}
                                    id={person.user_id}
                                    className={cn(
                                      'size-5 rounded-full',
                                      mobile && 'size-6',
                                      !person.muted &&
                                        !person.deafened &&
                                        'ring-2 ring-online/70 ring-offset-1 ring-offset-[color:var(--avatar-ring,var(--background))]',
                                    )}
                                  />
                                </span>
                                <span className="min-w-0 truncate">
                                  {person.name || 'Participant'}
                                  {person.deafened ? (
                                    <span aria-label="Deafened"> · deafened</span>
                                  ) : person.muted ? (
                                    <span aria-label="Muted"> · muted</span>
                                  ) : (
                                    ''
                                  )}
                                </span>
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
