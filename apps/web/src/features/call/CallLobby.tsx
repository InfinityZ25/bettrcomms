import { Headphones, MicOff, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { leadingInitials } from '@/components/avatar';
import type { Room, User } from '@/api';
import type { CallPresence, JoinMode } from './callTypes';

const rosterAvatar =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted text-xs font-semibold text-muted-foreground';

/** The pre-call screen: who is already here, and how to join them. */
export default function CallLobby({
  user,
  room,
  busy,
  names,
  callPresence,
  presenceKnown,
  onJoin,
}: {
  user: User | null;
  room: Room | null;
  busy: boolean;
  names: Record<string, string>;
  callPresence: CallPresence[];
  presenceKnown: boolean;
  onJoin: (mode: JoinMode) => void;
}) {
  const others = callPresence.filter((presence) => presence.user_id !== user?.id);
  const existingSelf = callPresence.find((presence) => presence.user_id === user?.id);
  const title =
    (room as (Room & { display_name?: string }) | null)?.display_name ||
    room?.name ||
    (user ? 'Choose a room' : 'Your call');
  const label = (presence: CallPresence) =>
    presence.name || names[presence.user_id] || 'Friend';

  return (
    <section className="call-lobby" aria-label="Call lobby">
      <div className="call-lobby__hero">
        <span className="call-lobby__eyebrow">Ready to join</span>
        <h2>{title}</h2>
        <p>
          {room
            ? 'Review who is here, then join with your selected microphone. Your camera stays off until you enable it.'
            : 'Select a room or direct conversation to see its call and join.'}
        </p>
        {existingSelf && user && room ? (
          <div className="call-lobby__device-choice">
            <strong aria-live="polite">
              You’re already in this call
              {existingSelf.device_count > 1
                ? ` on ${existingSelf.device_count} devices`
                : ' on another device'}
              .
            </strong>
            <p>
              Reconnect here to move the call to this device, or keep the other device
              connected and add this one.
            </p>
            <div>
              <Button onClick={() => onJoin('replace')} disabled={busy}>
                <Headphones size={18} /> {busy ? 'Connecting…' : 'Reconnect from here'}
              </Button>
              <Button variant="secondary" onClick={() => onJoin('additional')} disabled={busy}>
                <Plus size={18} /> Connect second device
              </Button>
            </div>
            <small>
              Mute or deafen one device if its speakers can feed the other device’s
              microphone.
            </small>
          </div>
        ) : (
          <Button onClick={() => onJoin('replace')} disabled={busy || Boolean(user && !room)}>
            <Headphones size={18} />{' '}
            {busy
              ? 'Connecting…'
              : !user
                ? 'Sign in to join'
                : room
                  ? 'Join call'
                  : 'Select a room to join'}
          </Button>
        )}
      </div>
      <div className="call-lobby__roster">
        <h3>In this call</h3>
        {!user ? (
          <p>Sign in to see who’s here.</p>
        ) : !room ? (
          <p>Select a room to see its call roster.</p>
        ) : !presenceKnown ? (
          <p role="status">Checking who’s here…</p>
        ) : others.length === 0 ? (
          <p>No one has joined yet. You can be the first.</p>
        ) : (
          <ul>
            {others.map((presence) => (
              <li key={presence.user_id}>
                <span className={rosterAvatar}>{leadingInitials(label(presence))}</span>
                <strong>{label(presence)}</strong>
                <span className="call-lobby__badges">
                  {presence.muted && (
                    <span>
                      <MicOff size={14} /> Muted
                    </span>
                  )}
                  {presence.deafened && (
                    <span>
                      <Headphones size={14} /> Deafened
                    </span>
                  )}
                  {presence.device_count > 1 && <span>{presence.device_count} devices</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
