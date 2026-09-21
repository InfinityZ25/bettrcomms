import { useEffect, useRef } from 'react';
import type { Message, Room, User } from '@/api';
import { notifyDesktop } from '@/desktop/notifications';
import { playSound } from '@/media/sounds';
import { useActiveCall } from './CallSessionContext';

/** True when this window is not the one being looked at. */
const away = () => document.hidden || !document.hasFocus();

/**
 * Old enough that announcing it would be news about the past.
 *
 * A minimised window's socket delivers its backlog in a burst when the window
 * comes back, and every one of those used to raise its own toast — a stack of
 * notifications for messages that arrived while nobody was there.
 */
const STALE_AFTER = 60_000;

/**
 * What the app does to get your attention about a conversation: the sounds,
 * and the desktop's own notifications where the host has them.
 *
 * Nothing but effects. It watches the state the call already publishes and
 * reacts to what changed, which keeps the session about media and signalling.
 * A sound plays for anything you are not looking at; a toast is raised only
 * when you are not looking at the app at all, because a notification about a
 * window you are in front of is noise with a corner.
 *
 * An incoming call is not here: it is a thing you answer, so it has a card of
 * its own in IncomingCall.
 */
export default function CallAlerts({
  user,
  viewing,
  messages,
}: {
  user: User | null;
  /**
   * The conversation actually in front of the reader, if one is. Not simply
   * the selected room: that stays selected while you are on another screen,
   * and a message you cannot see is exactly the one worth a sound.
   */
  viewing: Room | null;
  messages: { sequence: number; value: Message }[];
}) {
  const call = useActiveCall();
  const { joined, peers, remote } = call;

  // Your own arrival and departure.
  const wasJoined = useRef(joined);
  useEffect(() => {
    if (joined !== wasJoined.current) {
      playSound(joined ? 'join' : 'leave');
      wasJoined.current = joined;
    }
  }, [joined]);

  // Everybody else's, while you are in it to hear them.
  const known = useRef<string[]>([]);
  useEffect(() => {
    const current = Object.keys(peers);
    if (!joined) {
      known.current = current;
      return;
    }
    const arrived = current.some((id) => !known.current.includes(id));
    const left = known.current.some((id) => !current.includes(id));
    known.current = current;
    if (arrived) playSound('join');
    else if (left) playSound('leave');
  }, [peers, joined]);

  // A screen going up is worth looking at, so it gets a sound of its own.
  const shares = useRef<string[]>([]);
  useEffect(() => {
    const current = remote
      .filter((track) => track.source === 'screen')
      .map((track) => track.peerId);
    if (current.some((id) => !shares.current.includes(id))) playSound('share');
    shares.current = current;
  }, [remote]);

  /*
    Messages you are not already looking at.

    Everything that arrived since the last pass is considered together rather
    than one at a time, and each conversation gets a single toast for the lot:
    when a window comes back from being minimised its socket hands over the
    whole backlog at once, and the reader wants to know what they missed, not
    to dismiss it one message at a time.
  */
  const lastSeen = useRef(0);
  useEffect(() => {
    const fresh = messages.filter(
      (entry) =>
        entry.sequence > lastSeen.current &&
        entry.value.author.id !== user?.id &&
        Date.now() - Date.parse(entry.value.created_at) < STALE_AFTER,
    );
    const latest = messages.at(-1);
    if (latest) lastSeen.current = Math.max(lastSeen.current, latest.sequence);
    if (!fresh.length) return;

    const watching = (roomId: string) =>
      roomId === viewing?.id && !document.hidden;
    if (fresh.some((entry) => !watching(entry.value.room_id)))
      playSound('notification');
    if (!away()) return;

    const byRoom = new Map<string, Message[]>();
    for (const { value } of fresh) {
      const room = byRoom.get(value.room_id) ?? [];
      room.push(value);
      byRoom.set(value.room_id, room);
    }
    for (const [roomId, group] of byRoom) {
      const last = group[group.length - 1]!;
      void notifyDesktop({
        // One toast per conversation, replaced rather than stacked.
        id: `message:${roomId}`,
        title: last.author.name,
        body:
          group.length > 1
            ? `${last.body}\n+${group.length - 1} more`
            : last.body,
        data: { roomId },
      });
    }
  }, [messages, viewing?.id, user?.id]);

  return null;
}
