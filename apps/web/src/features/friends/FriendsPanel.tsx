import { errorMessage } from '@/lib/errors';
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { Ban, Check, MessageSquare, Plus, Search, Users, X } from 'lucide-react';
import {
  api,
  type User,
  type Room,
  type FriendRequest,
  type CallParticipant,
} from '@/api';
import { Mascot } from '@/components/mascot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import PrivacyPanel from './PrivacyPanel';
import { Avatar } from '@/components/avatar';
import { useMountEffect } from '@/hooks/useMountEffect';
import { profileSnapshot, subscribeProfiles } from '@/features/settings/profileStore';
import { contactStatus, presenceLabels, type ContactStatus } from '@/features/settings/presenceStore';

function FriendsLoader({ load, onError }: { load: (signal: AbortSignal) => Promise<void>; onError: (error: string) => void }) {
  useMountEffect(() => {
    const request = new AbortController();
    void load(request.signal).catch((error) => { if (!request.signal.aborted) onError(errorMessage(error)); });
    return () => request.abort();
  });
  return null;
}
function PersonIdentity({ user, status }: { user: User; status?: ContactStatus }) {
  return <div className="flex min-w-0 flex-1 items-start gap-2.5">
    <Avatar name={user.name} id={user.id} src={user.avatar_url} presence={status === 'idle' ? 'away' : status} />
    <div className="min-w-0 flex-1">
      <strong className="block [overflow-wrap:anywhere]">{user.name}</strong>
      <small className="mt-1 block [overflow-wrap:anywhere] text-[0.7rem] text-muted-foreground">{user.username ? `@${user.username}` : user.email}</small>
      {user.bio && <details className="mt-1 text-[0.7rem] text-muted-foreground"><summary className="cursor-pointer">About</summary><p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{user.bio}</p></details>}
    </div>
  </div>;
}

export default function FriendsPanel({
  user,
  room,
  onError,
  onOpenRoom,
  callPresence = {},
  refreshRevision = 0,
  onlineUsers = {},
  contactStatuses = {},
}: {
  user: User;
  room: Room | null;
  onError: (s: string) => void;
  onOpenRoom?: (room: Room) => void;
  callPresence?: Record<string, CallParticipant[]>;
  refreshRevision?: number;
  onlineUsers?: Record<string, boolean>;
  contactStatuses?: Record<string, ContactStatus>;
}) {
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<User[]>([]),
    [friends, setFriends] = useState<User[]>([]),
    [requests, setRequests] = useState<FriendRequest[]>([]),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false),
    [requestTarget, setRequestTarget] = useState<User | null>(null),
    [requestBody, setRequestBody] = useState(''),
    [privacyRevision, setPrivacyRevision] = useState(0);
  const profiles = useSyncExternalStore(subscribeProfiles, profileSnapshot);
  const latest = (person: User) => {
    const cached = profiles[person.id];
    return cached && (cached.profile_version ?? 0) >= (person.profile_version ?? 0) ? cached : person;
  };
  async function refresh(signal?: AbortSignal) {
    const r = await api<{ friends: User[]; requests: FriendRequest[] }>(
      '/friends',
      undefined, undefined, signal,
    );
    if (signal?.aborted) return;
    setFriends(r.friends ?? []);
    setRequests(r.requests ?? []);
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ users: User[] }>(
        '/users?q=' + encodeURIComponent(query),
      );
      setResults(r.users ?? []);
      setStatus(
        r.users?.length
          ? ''
          : 'No one found. Try their username, email or display name. You can also paste their user ID below.',
      );
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <FriendsLoader key={`${user.id}:${refreshRevision}`} load={refresh} onError={onError} />
      <form onSubmit={search}>
        <label className="block text-xs font-medium text-foreground/80">
          Find your people
          <div className="mt-2 flex items-center gap-2">
            <Input
              placeholder="Search username, name or email"
              aria-label="Find friends"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              minLength={2}
              required
            />
            <Button
              type="submit"
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
      {results.map(latest).map((u) => (
        <div
          className="flex flex-wrap items-center justify-between gap-2.5 border-b py-2 text-xs"
          key={u.id}
        >
          <PersonIdentity user={u} />
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
          {!friends.some((friend) => friend.id === u.id) && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRequestTarget(u); setRequestBody(''); }}>
              <MessageSquare size={14} /> Request DM
            </Button>
          )}
          <Button size="icon" variant="ghost" disabled={busy} aria-label={`Block ${u.name}`} onClick={() =>
            action(async () => {
              await api(`/privacy/blocks/${u.id}`, {}, 'POST');
              setResults((current) => current.filter((person) => person.id !== u.id));
              setPrivacyRevision((current) => current + 1);
            })
          }><Ban size={14} /></Button>
        </div>
      ))}
      {requestTarget && (
        <form className="space-y-2 rounded-xl border p-3 text-xs" onSubmit={(event) => {
          event.preventDefault();
          void action(async () => {
            await api('/dm-requests', { user_id: requestTarget.id, body: requestBody });
            setStatus(`Message request sent to ${requestTarget.name}.`);
            setRequestTarget(null);
            setRequestBody('');
            setPrivacyRevision((current) => current + 1);
          });
        }}>
          <label className="block font-medium" htmlFor="dm-request-body">Request a conversation with {requestTarget.name}</label>
          <textarea id="dm-request-body" className="min-h-20 w-full rounded-lg border bg-background p-2" value={requestBody} maxLength={500} required onChange={(event) => setRequestBody(event.target.value)} placeholder="Write a short first message" />
          <div className="flex gap-2"><Button size="sm" disabled={busy || !requestBody.trim()} type="submit">Send request</Button><Button size="sm" variant="ghost" type="button" onClick={() => setRequestTarget(null)}>Cancel</Button></div>
        </form>
      )}
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
          <Input
            name="userId"
            aria-label="Friend user ID"
            placeholder="Paste their user ID"
            required
          />
          <Button type="submit" variant="secondary" size="sm" disabled={busy}>
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
            <div className="min-w-0 flex-1">
              <PersonIdentity user={latest(incoming ? r.sender : r.receiver)} />
              <small className="mt-1 block text-[0.7rem] text-muted-foreground">
                {incoming ? 'Wants to be your friend' : 'Request sent'}
              </small>
            </div>
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
        <div className="flex items-center gap-3">
          <Mascot className="w-10 shrink-0" />
          <p className="text-xs leading-6 text-muted-foreground">
            Every good room starts with a friend.
          </p>
        </div>
      )}
      {friends.map(latest).map((f) => (
        <div
          role="group"
          aria-label={`Friend ${f.name}`}
          // On a phone the name takes the full width and its actions wrap
          // below it, instead of squeezing the name into a column.
          className="flex items-center justify-between gap-2.5 border-b py-2 text-xs phone:flex-wrap phone:justify-start phone:gap-y-1.5"
          key={f.id}
        >
          <div className="min-w-0 flex-1 phone:basis-full">
            <PersonIdentity user={f} status={contactStatuses[f.id] ?? contactStatus(undefined, Boolean(onlineUsers[f.id]))} />
            <small className="mt-1 block [overflow-wrap:anywhere] text-[0.7rem] text-muted-foreground">
              {(() => {
                const state = Object.values(callPresence)
                  .flat()
                  .find((person) => person.user_id === f.id);
                return state
                  ? `In a shared call${state.deafened ? ' · Deafened' : state.muted ? ' · Muted' : ''}`
                  : presenceLabels[contactStatuses[f.id] ?? contactStatus(undefined, Boolean(onlineUsers[f.id]))];
              })()}
            </small>
          </div>
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
          <Button size="icon" variant="ghost" disabled={busy} aria-label={`Block ${f.name}`} onClick={() =>
            action(async () => {
              await api(`/privacy/blocks/${f.id}`, {}, 'POST');
              setPrivacyRevision((current) => current + 1);
            })
          }><Ban size={14} /></Button>
          {room?.owner_id === user.id && (room.kind ?? 'channel') === 'channel' && (
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
      <PrivacyPanel key={`${user.id}:${refreshRevision}:${privacyRevision}`} userId={user.id} onOpenRoom={onOpenRoom} onError={onError} />
    </div>
  );
}
