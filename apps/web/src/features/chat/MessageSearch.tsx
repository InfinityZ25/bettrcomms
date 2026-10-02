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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMountEffect } from '@/hooks/useMountEffect';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import { formatMessagePreview } from './messageFormatting';

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
  const [authors, setAuthors] = useState<User[]>([]);
  const [personQuery, setPersonQuery] = useState('');
  const [findingPerson, setFindingPerson] = useState(false);
  const peopleController = useRef<AbortController | null>(null);
  const [page, setPage] = useState<MessagePage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
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
    if (query.trim().length < 2) return;
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
            <Button type="submit" disabled={busy || query.trim().length < 2}>
              <Search size={16} />
              Search
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
              Conversation
              <select
                className="rounded-lg border bg-background p-2"
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
                className="rounded-lg border bg-background p-2"
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
                className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-xs"
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
          <p role="status" className="text-xs">
            Searching…
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="min-h-0 overflow-auto" aria-label="Search results">
          {page?.messages.map((message) => (
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
            <p className="p-4 text-sm text-muted-foreground">
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
      className="mb-2 block w-full rounded-xl border p-3 text-left hover:bg-muted"
    >
      <span className="block text-xs text-muted-foreground">
        {room ? roomLabel(room) : 'Conversation'} · {message.author.name} ·{' '}
        {new Date(message.created_at).toLocaleString()}
      </span>
      <span className="mt-1 block whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
        {formatMessagePreview(message.body)}
      </span>
      <span className="mt-1 block text-xs text-primary">Go to message</span>
    </button>
  );
}
