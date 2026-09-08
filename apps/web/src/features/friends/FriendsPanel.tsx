import { useEffect, useState, type FormEvent } from 'react';
import { Check, Plus, Search, Users, X } from 'lucide-react';
import {
  api,
  type User,
  type Room,
  type FriendRequest,
  type CallParticipant,
} from '@/api';
import { Button } from '@/components/ui/button';

export default function FriendsPanel({
  user,
  room,
  onError,
  onOpenRoom,
  callPresence = {},
}: {
  user: User;
  room: Room | null;
  onError: (s: string) => void;
  onOpenRoom?: (room: Room) => void;
  callPresence?: Record<string, CallParticipant[]>;
}) {
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<User[]>([]),
    [friends, setFriends] = useState<User[]>([]),
    [requests, setRequests] = useState<FriendRequest[]>([]),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    const r = await api<{ friends: User[]; requests: FriendRequest[] }>(
      '/friends',
    );
    setFriends(r.friends ?? []);
    setRequests(r.requests ?? []);
  }
  useEffect(() => {
    refresh().catch((e) => onError(e.message));
  }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function search(e: FormEvent) {
    e.preventDefault();
    await action(async () => {
      const r = await api<{ users: User[] }>(
        '/users?q=' + encodeURIComponent(query),
      );
      setResults(r.users ?? []);
      setStatus(
        r.users?.length
          ? ''
          : 'No one found. Try their email or name. You can also paste their user ID below.',
      );
    });
  }
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={search}>
        <label className="block text-xs font-medium text-foreground/80">
          Find your people
          <div className="mt-2 flex items-center gap-2">
            <input
              placeholder="Search name or email"
              aria-label="Find friends"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              minLength={2}
              required
            />
            <Button
              variant="secondary"
              size="icon"
              aria-label="Search friends"
              disabled={busy}
            >
              <Search size={17} />
            </Button>
          </div>
        </label>
      </form>
      {status && (
        <p className="text-xs leading-6 text-muted-foreground" role="status">
          {status}
        </p>
      )}
      {results.map((u) => (
        <div
          className="flex items-center justify-between gap-2.5 border-b py-2 text-xs"
          key={u.id}
        >
          <span className="min-w-0 flex-1">
            <strong className="block">{u.name}</strong>
            <small className="mt-1 block [overflow-wrap:anywhere] text-[0.7rem] text-muted-foreground">
              {u.email}
            </small>
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={
              busy ||
              friends.some((f) => f.id === u.id) ||
              requests.some(
                (r) => r.receiver.id === u.id || r.sender.id === u.id,
              )
            }
            onClick={() =>
              action(async () => {
                await api('/friends/requests', { user_id: u.id });
                setStatus('Friend request sent.');
              })
            }
          >
            <Plus size={14} /> Add friend
          </Button>
        </div>
      ))}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Add by user ID</summary>
        <form
          className="mt-2.5 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get('userId');
            action(async () => {
              await api('/friends/requests', { user_id: value });
              setStatus('Friend request sent.');
            });
          }}
        >
          <input
            name="userId"
            aria-label="Friend user ID"
            placeholder="Paste their user ID"
            required
          />
          <Button variant="secondary" size="sm" disabled={busy}>
            Send request
          </Button>
        </form>
      </details>
      {requests.length > 0 && (
        <h3 className="mt-2.5 flex items-center gap-2 text-sm font-semibold">
          Friend requests
        </h3>
      )}
      {requests.map((r) => {
        const incoming = r.receiver.id === user.id;
        return (
          <div
            className="flex items-center justify-between gap-2.5 border-b py-2 text-xs"
            key={r.id}
          >
            <span className="min-w-0 flex-1">
              <strong className="block">
                {incoming ? r.sender.name : r.receiver.name}
              </strong>
              <small className="mt-1 block text-[0.7rem] text-muted-foreground">
                {incoming ? 'Wants to be your friend' : 'Request sent'}
              </small>
            </span>
            {incoming ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api('/friends/requests/' + r.id + '/accept', {});
                    setStatus('You’re now friends.');
                  })
                }
              >
                <Check size={14} /> Accept
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">Pending</span>
            )}
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              aria-label={incoming ? 'Decline request' : 'Cancel request'}
              onClick={() =>
                action(async () => {
                  await api(
                    '/friends/' + (incoming ? r.sender.id : r.receiver.id),
                    undefined,
                    'DELETE',
                  );
                })
              }
            >
              <X size={14} />
            </Button>
          </div>
        );
      })}
      <h3 className="mt-2.5 flex items-center gap-2 text-sm font-semibold">
        <Users size={16} /> Your friends{' '}
        <span className="ml-auto text-muted-foreground">{friends.length}</span>
      </h3>
      {!friends.length && (
        <p className="text-xs leading-6 text-muted-foreground">
          Every good room starts with a friend.
        </p>
      )}
      {friends.map((f) => (
        <div
          className="flex items-center justify-between gap-2.5 border-b py-2 text-xs"
          key={f.id}
        >
          <span className="min-w-0 flex-1">
            <strong className="block">{f.name}</strong>
            <small className="mt-1 block [overflow-wrap:anywhere] text-[0.7rem] text-muted-foreground">
              {(() => {
                const state = Object.values(callPresence)
                  .flat()
                  .find((person) => person.user_id === f.id);
                return state
                  ? `In a shared call${state.deafened ? ' · Deafened' : state.muted ? ' · Muted' : ''}`
                  : f.email;
              })()}
            </small>
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              action(async () => {
                const r = await api<{ room: Room }>('/rooms/direct', {
                  user_id: f.id,
                });
                onOpenRoom?.({
                  ...r.room,
                  display_name: r.room.display_name || f.name,
                });
              })
            }
          >
            Message
          </Button>
          {room?.owner_id === user.id && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api('/rooms/' + room.id + '/members', {
                    user_id: f.id,
                  });
                  setStatus(`${f.name} can now join ${room.name}.`);
                })
              }
            >
              Invite to room
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
