import { useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import {
  ArrowUpRight,
  Hash,
  LoaderCircle,
  MessageSquare,
  Search,
  Settings2,
  Star,
  Users,
} from 'lucide-react';
import { api, type PublicUser, type Room } from '@/api';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useMountEffect } from '@/hooks/useMountEffect';
import { getDesktopRuntime } from '@/desktop/runtime';
import {
  conversationPreferencesSnapshot,
  subscribeConversationPreferences,
} from '@/features/rooms/conversationPreferences';
import {
  profileSnapshot,
  subscribeProfiles,
} from '@/features/settings/profileStore';
import { sessionGeneration } from '@/features/auth/sessionEvents';
import {
  quickAccessGroups,
  quickAccessItems,
  type QuickDestination,
  type QuickGroup,
  type QuickItem,
} from './quickAccessModel';
type Resources = {
  rooms: Room[];
  friends: PublicUser[];
  loading: boolean;
  errors: string[];
};
const emptyResources: Resources = {
  rooms: [],
  friends: [],
  loading: true,
  errors: [],
};

export default function QuickAccessResults({
  userId,
  revision,
  query,
  onQueryChange,
  inputRef,
  onNavigate,
}: {
  userId: string;
  revision: string;
  query: string;
  onQueryChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onNavigate: (destination: QuickDestination) => void;
}) {
  const [loaded, setLoaded] = useState<{
    revision: string;
    retry: number;
    value: Resources;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selecting = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const preferences = useSyncExternalStore(
    subscribeConversationPreferences,
    conversationPreferencesSnapshot,
  );
  const profiles = useSyncExternalStore(subscribeProfiles, profileSnapshot);
  // A fresh invalidation removes old permissions immediately, without replacing the input.
  const resources =
    loaded?.revision === revision && loaded.retry === retry
      ? loaded.value
      : emptyResources;
  useMountEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    const element = inputRef.current;
    const dialog = element?.closest('[data-quick-access]');
    // The lazy body can arrive after Dialog's initial focus pass. Never take
    // focus from a subsequently opened modal or a control outside this dialog.
    if (element && dialog?.contains(document.activeElement)) element.focus();
    return () => {
      abort.abort();
      if (lifetime.current === abort) lifetime.current = null;
    };
  });
  const friends = resources.friends.map((friend) => {
    const current = profiles[friend.id];
    return current &&
      (current.profile_version || 0) >= (friend.profile_version || 0)
      ? current
      : friend;
  });
  const items = quickAccessItems(
    resources.rooms,
    friends,
    preferences.userId === userId ? preferences.preferences : {},
    getDesktopRuntime() === 'wails',
  );
  const groups = quickAccessGroups(items, query);
  const choose = async (item: QuickItem) => {
    if (
      selecting.current ||
      !lifetime.current ||
      lifetime.current.signal.aborted
    )
      return;
    if (item.destination.kind !== 'friend') {
      onNavigate(item.destination);
      return;
    }
    selecting.current = true;
    setBusy(true);
    setError('');
    const signal = lifetime.current.signal;
    const generation = sessionGeneration();
    try {
      // The existing idempotent route either opens the DM or creates it after this explicit choice.
      const friend = item.destination.friend;
      const result = await api<{ room: Room }>(
        '/rooms/direct',
        { user_id: friend.id },
        'POST',
        signal,
      );
      if (signal.aborted || generation !== sessionGeneration()) return;
      onNavigate({
        kind: 'room',
        room: {
          ...result.room,
          display_name: result.room.display_name || friend.name,
        },
      });
    } catch (failure) {
      if (!signal.aborted && generation === sessionGeneration())
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not open this conversation. Try again.',
        );
    } finally {
      selecting.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <Autocomplete.Root
      items={groups}
      filteredItems={groups}
      mode="none"
      open
      inline
      autoHighlight="always"
      keepHighlight
      value={query}
      onValueChange={onQueryChange}
      itemToStringValue={(item: QuickItem) => item.label}
    >
      <QuickAccessLoader
        key={`${revision}:${retry}`}
        onLoaded={(value) => setLoaded({ revision, retry, value })}
      />
      <Autocomplete.InputGroup className="group/search mx-4 mb-4 flex min-h-14 shrink-0 items-center gap-3 rounded-2xl border border-border bg-background/60 px-4 shadow-[var(--highlight)] transition-[border-color,box-shadow] duration-150 focus-within:border-ring/60 focus-within:ring-4 focus-within:ring-ring/15">
        <Search
          aria-hidden="true"
          className="size-5 shrink-0 text-muted-foreground transition-colors group-focus-within/search:text-primary"
        />
        <Autocomplete.Input
          ref={inputRef}
          aria-label="Find a friend, channel or setting"
          aria-describedby="quick-access-help"
          placeholder="Friend, channel or setting…"
          maxLength={120}
          className="h-14 w-full min-w-0 rounded-none border-0 bg-transparent px-0 py-0 text-base shadow-none outline-none placeholder:text-muted-foreground hover:border-0 focus-visible:border-0 focus-visible:bg-transparent focus-visible:ring-0 sm:text-[0.9375rem]"
        />
      </Autocomplete.InputGroup>
      <Separator />
      {resources.loading && (
        <p role="status" className="px-5 pt-3 text-xs text-muted-foreground">
          Loading friends and conversations…
        </p>
      )}
      {resources.errors.length > 0 && (
        <div className="flex items-center gap-2 px-5 pt-3">
          <p role="alert" className="flex-1 text-xs text-muted-foreground">
            {resources.errors.join(' ')}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-2"
        aria-busy={busy}
      >
        <Autocomplete.Empty className="px-3 py-12 text-center text-sm text-muted-foreground empty:py-0">
          No destinations found. Try a name, room or setting.
        </Autocomplete.Empty>
        <Autocomplete.List aria-label="Quick access destinations">
          {(group: QuickGroup) => (
            <Autocomplete.Group
              key={group.value}
              items={group.items}
              className="pb-1.5"
            >
              <Autocomplete.GroupLabel className="px-3 pt-3 pb-2 text-[0.6875rem] leading-4 font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                {group.value}
              </Autocomplete.GroupLabel>
              <Autocomplete.Collection>
                {(item: QuickItem) => (
                  <Autocomplete.Item
                    key={item.id}
                    value={item}
                    disabled={busy}
                    onClick={() => void choose(item)}
                    className="group relative flex min-h-14 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 outline-none transition-colors duration-100 before:absolute before:top-1/2 before:left-0 before:h-0 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-primary before:transition-[height] before:duration-150 data-highlighted:bg-primary/10 data-highlighted:text-foreground data-highlighted:before:h-6 data-disabled:pointer-events-none data-disabled:opacity-60"
                  >
                    <DestinationIcon item={item} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-semibold">
                        {item.label}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {item.subtitle}
                      </span>
                    </span>
                    {item.favorite && (
                      <Star
                        aria-label="Favorite"
                        className="size-3.5 shrink-0 fill-primary text-primary"
                      />
                    )}
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-primary opacity-0 transition-[opacity,transform] duration-150 group-data-highlighted:translate-x-0.5 group-data-highlighted:-translate-y-0.5 group-data-highlighted:opacity-100"
                    />
                  </Autocomplete.Item>
                )}
              </Autocomplete.Collection>
            </Autocomplete.Group>
          )}
        </Autocomplete.List>
      </div>
      {error && (
        <p role="alert" className="px-5 pb-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {busy && (
        <p
          role="status"
          className="flex items-center gap-2 px-5 pb-3 text-xs text-muted-foreground"
        >
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Opening conversation…
        </p>
      )}
      <Separator />
      <p
        id="quick-access-help"
        className="shrink-0 px-5 py-3 text-xs leading-6 text-muted-foreground [&>kbd]:mx-px [&>kbd]:inline-grid [&>kbd]:h-5 [&>kbd]:min-w-5 [&>kbd]:place-items-center [&>kbd]:rounded-md [&>kbd]:border [&>kbd]:border-b-2 [&>kbd]:border-border [&>kbd]:bg-sidebar-accent [&>kbd]:px-1 [&>kbd]:align-middle [&>kbd]:font-sans [&>kbd]:text-[0.6875rem] [&>kbd]:leading-none [&>kbd]:font-semibold [&>kbd]:text-foreground"
      >
        <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
      </p>
    </Autocomplete.Root>
  );
}

function QuickAccessLoader({
  onLoaded,
}: {
  onLoaded: (resources: Resources) => void;
}) {
  useMountEffect(() => {
    const abort = new AbortController();
    const generation = sessionGeneration();
    void Promise.allSettled([
      api<{ rooms: Room[] }>('/rooms', undefined, undefined, abort.signal),
      api<{ friends: PublicUser[] }>(
        '/friends',
        undefined,
        undefined,
        abort.signal,
      ),
    ]).then(([rooms, friends]) => {
      if (abort.signal.aborted || generation !== sessionGeneration()) return;
      onLoaded({
        rooms: rooms.status === 'fulfilled' ? rooms.value.rooms || [] : [],
        friends:
          friends.status === 'fulfilled'
            ? (friends.value.friends || []).map(
                ({ id, name, username, avatar_url, profile_version }) => ({
                  id,
                  name,
                  username,
                  avatar_url,
                  profile_version,
                }),
              )
            : [],
        loading: false,
        errors: [
          rooms.status === 'rejected' ? 'Conversations could not load.' : '',
          friends.status === 'rejected' ? 'Friends could not load.' : '',
        ].filter(Boolean),
      });
    });
    return () => abort.abort();
  });
  return null;
}

function DestinationIcon({ item }: { item: QuickItem }) {
  const Icon =
    item.group === 'Settings'
      ? Settings2
      : item.group === 'Channels'
        ? Hash
        : item.group === 'Conversations'
          ? MessageSquare
          : item.group === 'Friends' || item.group === 'Rooms'
            ? Users
            : ArrowUpRight;
  return (
    // Each kind of destination keeps its own colour, so a long list sorts
    // itself by eye before it is read.
    <span
      className={`grid size-9 shrink-0 place-items-center rounded-xl transition-transform duration-150 group-data-highlighted:scale-105 ${
        item.group === 'Settings'
          ? 'bg-violet/15 text-violet'
          : item.group === 'Channels'
            ? 'bg-primary/15 text-primary'
            : item.group === 'Conversations'
              ? 'bg-cyan/15 text-cyan'
              : item.group === 'Friends' || item.group === 'Rooms'
                ? 'bg-amber/15 text-amber'
                : 'bg-muted text-muted-foreground'
      }`}
      aria-hidden="true"
    >
      <Icon className="size-[1.125rem]" />
    </span>
  );
}
