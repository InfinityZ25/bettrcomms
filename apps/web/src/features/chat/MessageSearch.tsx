import { useRef, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import {
  api,
  type Message,
  type MessagePage,
  type Room,
  type User,
} from '@/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMountEffect } from '@/hooks/useMountEffect';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import { formatMessagePreview } from './messageFormatting';
import { dateRange, quickDateRange } from '@/features/personal/time';
import { hasBlockingOverlay } from '@/features/shell/shortcutGuards';

export default function MessageSearch({
  rooms,
  user,
  onOpen,
}: {
  rooms: Room[];
  user: User;
  onOpen: (room: Room, messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('');
  const [query, setQuery] = useState('');
  const [author, setAuthor] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [throughDate, setThroughDate] = useState('');
  const [kind, setKind] = useState('');
  const [authors, setAuthors] = useState<User[]>([]);
  const [personQuery, setPersonQuery] = useState('');
  const [findingPerson, setFindingPerson] = useState(false);
  const peopleController = useRef<AbortController | null>(null);
  const [page, setPage] = useState<MessagePage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const searchable = (query.trim().length === 0 || query.trim().length >= 2) && Boolean(query.trim().length >= 2 || scope || author || fromDate || throughDate || kind);
  const loadPeople = async (roomId: string, name?: string) => {
    peopleController.current?.abort();
    const abort = new AbortController();
    peopleController.current = abort;
    if (!roomId && !name) return;
    setFindingPerson(true);
    try {
      const people = roomId
        ? (
            await api<{ members: { user: User }[] }>(
              `/rooms/${roomId}/members`,
              undefined,
              undefined,
              abort.signal,
            )
          ).members.map((member) => member.user)
        : (
            await api<{ users: User[] }>(
              `/users?q=${encodeURIComponent(name!)}`,
              undefined,
              undefined,
              abort.signal,
            )
          ).users;
      if (!abort.signal.aborted)
        setAuthors((previous) => [
          ...new Map(
            [...previous, ...people].map((person) => [person.id, person]),
          ).values(),
        ]);
    } catch (reason) {
      if (!abort.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : 'Could not find people',
        );
    } finally {
      if (!abort.signal.aborted) setFindingPerson(false);
    }
  };
  const openSearch = (roomId?: string | null) => {
    controller.current?.abort();
    request.current += 1;
    const nextScope = typeof roomId === 'string' ? roomId : '';
    setScope(nextScope);
    setAuthor('');
    setFromDate(''); setThroughDate(''); setKind('');
    setPage(null);
    setAuthors([user]);
    setPersonQuery('');
    setError('');
    setBusy(false);
    setFindingPerson(false);
    setOpen(true);
    void loadPeople(nextScope);
  };
  useMountEffect(() => {
    const show = (event: Event) =>
      openSearch((event as CustomEvent<string | undefined>).detail);
    const shortcut = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && !event.repeat && !event.isComposing && !event.altKey
        && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f'
        && !hasBlockingOverlay()) {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('bc-message-search', show);
    window.addEventListener('keydown', shortcut);
    return () => {
      controller.current?.abort();
      peopleController.current?.abort();
      window.removeEventListener('bc-message-search', show);
      window.removeEventListener('keydown', shortcut);
    };
  });
  const close = (value: boolean) => {
    setOpen(value);
    if (!value) {
      controller.current?.abort();
      peopleController.current?.abort();
      setFindingPerson(false);
      request.current += 1;
      setBusy(false);
    }
  };
  const search = async (event?: FormEvent, older = false) => {
    event?.preventDefault();
    if (!searchable) return;
    let range: { from?: string; to?: string };
    try { range = dateRange(fromDate, throughDate); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Choose valid search dates.'); return; }
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++request.current;
    const params = new URLSearchParams({
      q: query.trim(),
      room_id: scope,
      author_id: author,
      limit: '30',
    });
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    if (kind) params.set('kind', kind);
    if (older && page?.before_id) params.set('before_id', page.before_id);
    setBusy(true);
    setError('');
    try {
      const result = await api<MessagePage>(
        `/messages/search?${params}`,
        undefined,
        undefined,
        abort.signal,
      );
      if (current === request.current)
        setAuthors((previous) => [
          ...new Map(
            [
              ...previous,
              ...result.messages.map((message) => message.author),
            ].map((person) => [person.id, person]),
          ).values(),
        ]);
      if (current === request.current)
        setPage(
          older
            ? {
                ...result,
                messages: [...(page?.messages ?? []), ...result.messages],
              }
            : result,
        );
    } catch (reason) {
      if (!abort.signal.aborted)
        setError(reason instanceof Error ? reason.message : 'Search failed');
    } finally {
      if (current === request.current) setBusy(false);
    }
  };
  const invalidated = () => {
    controller.current?.abort();
    request.current += 1;
    setBusy(false);
    setPage(null);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Search messages</DialogTitle>
          <DialogDescription>Find words, links or files. You can search with filters alone.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void search(event)} className="space-y-3">
          <div className="flex gap-2">
            <input
              type="search"
              aria-label="Search messages"
              value={query}
              maxLength={200}
              placeholder="Search words or an exact phrase"
              className="min-w-0 flex-1 rounded-xl border bg-background px-3 py-2"
              onChange={(event) => {
                setQuery(event.target.value);
                invalidated();
              }}
            />
            <Button type="submit" className="min-h-11" disabled={busy || !searchable}>
              <Search size={16} />
              Search
            </Button>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Search date shortcuts">
            {(['today', 'yesterday', 'week'] as const).map((preset) => <Button key={preset} type="button" size="sm" variant="outline" className="min-h-11" onClick={() => { const range = quickDateRange(preset); setFromDate(range.from); setThroughDate(range.through); invalidated(); }}>{preset === 'week' ? 'This week' : preset === 'today' ? 'Today' : 'Yesterday'}</Button>)}
            {(fromDate || throughDate || kind) && <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={() => { setFromDate(''); setThroughDate(''); setKind(''); invalidated(); }}>Clear date and type</Button>}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <label className="grid min-w-0 gap-1 text-xs" htmlFor="search-from-date">From<input id="search-from-date" type="date" aria-label="Search from date" className="min-h-11 min-w-0 rounded-xl border bg-background p-2" value={fromDate} onChange={(event) => { setFromDate(event.target.value); invalidated(); }} /></label>
            <label className="grid min-w-0 gap-1 text-xs" htmlFor="search-through-date">Through<input id="search-through-date" type="date" aria-label="Search through date" className="min-h-11 min-w-0 rounded-xl border bg-background p-2" value={throughDate} onChange={(event) => { setThroughDate(event.target.value); invalidated(); }} /></label>
            <label className="col-span-2 grid min-w-0 gap-1 text-xs sm:col-span-1" htmlFor="search-content-type">Content<select id="search-content-type" aria-label="Search content type" className="min-h-11 min-w-0 rounded-xl border bg-background p-2" value={kind} onChange={(event) => { setKind(event.target.value); invalidated(); }}><option value="">All content</option><option value="link">Links</option><option value="image">Images</option><option value="video">Videos</option><option value="audio">Audio</option><option value="file">Files</option></select></label>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
              Conversation
              <select
                className="rounded-xl border bg-background p-2"
                aria-label="Search conversation"
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value);
                  setAuthor('');
                  setAuthors([user]);
                  setFindingPerson(false);
                  void loadPeople(event.target.value);
                  invalidated();
                }}
              >
                <option value="">All conversations</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {roomLabel(room)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
              Author
              <select
                className="rounded-xl border bg-background p-2"
                aria-label="Search author"
                value={author}
                onChange={(event) => {
                  setAuthor(event.target.value);
                  invalidated();
                }}
              >
                <option value="">Anyone</option>
                {authors.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!scope && (
            <div className="flex items-center gap-2">
              <input
                aria-label="Find message author"
                value={personQuery}
                maxLength={200}
                placeholder="Find a person by name or email"
                className="min-w-0 flex-1 rounded-xl border bg-background px-3 py-2 text-xs"
                onChange={(event) => setPersonQuery(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={findingPerson || personQuery.trim().length < 2}
                onClick={() => void loadPeople('', personQuery.trim())}
              >
                {findingPerson ? 'Finding…' : 'Find person'}
              </Button>
            </div>
          )}
        </form>
        {busy && (
          <p role="status" className="text-xs text-muted-foreground">
            Searching…
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {(fromDate || throughDate) && <p className="text-xs text-muted-foreground">Dates use {Intl.DateTimeFormat().resolvedOptions().timeZone}; the through date includes the whole day.</p>}
        <div className="min-h-0 overflow-auto" aria-label="Search results">
          {page?.messages.filter((message) => rooms.some((room) => room.id === message.room_id)).map((message) => (
            <SearchResult
              key={message.id}
              message={message}
              room={rooms.find((room) => room.id === message.room_id)}
              onClick={() => {
                const room = rooms.find((room) => room.id === message.room_id);
                if (room) {
                  onOpen(room, message.id);
                  close(false);
                }
              }}
            />
          ))}
          {page && !page.messages.length && (
            <p className="animate-bc-rise p-4 text-center text-sm text-muted-foreground">
              No messages found.
            </p>
          )}
          {page?.before_id && (
            <Button
              variant="outline"
              className="mt-3 w-full"
              disabled={busy}
              onClick={() => void search(undefined, true)}
            >
              More results
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
function SearchResult({
  message,
  room,
  onClick,
}: {
  message: Message;
  room?: Room;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-2 block w-full rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-accent/60"
    >
      <span className="block text-xs text-muted-foreground">
        {room ? roomLabel(room) : 'Conversation'} · {message.author.name} ·{' '}
        {new Date(message.created_at).toLocaleString()}
      </span>
      <span className="mt-1 block whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
        {formatMessagePreview(message.body)}
      </span>
      {!!message.attachments?.length && <span className="mt-1 block truncate text-xs text-muted-foreground">{message.attachments.map((attachment) => attachment.filename).join(' · ')}</span>}
      <span className="mt-1 block text-xs font-medium text-primary">Go to message</span>
    </button>
  );
}
