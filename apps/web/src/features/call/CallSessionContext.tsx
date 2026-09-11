import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { CallParticipant, Room, User } from '@/api';
import { useCallSession } from './useCallSession';
import {
  EMPTY_CALL_PRESENCE,
  type CallPresence,
  type NativeShareActions,
} from './callTypes';

/**
 * The live call, plus the room bookkeeping that keeps it anchored.
 *
 * `room` is what the call screen renders. It is the room the call was joined
 * in for as long as the call is live, and the browsed room otherwise.
 */
export type CallSession = ReturnType<typeof useCallSession> & {
  /** The room the live call belongs to. Null when no call is live. */
  callRoom: Room | null;
  room: Room | null;
  callPresence: CallPresence[];
  presenceKnown: boolean;
};

/** What the shell needs to know about the call to lay itself out. */
export type CallChrome = { joined: boolean; room: Room | null };

const CallSessionContext = createContext<CallSession | null>(null);

/**
 * Reads the call the app is currently in.
 *
 * Throwing rather than returning null is deliberate: a component that renders
 * call UI outside the provider is a mounting mistake, and the call session must
 * never be silently recreated per screen.
 */
export function useActiveCall(): CallSession {
  const session = useContext(CallSessionContext);
  if (!session)
    throw new Error(
      'useActiveCall must be rendered inside a CallSessionProvider',
    );
  return session;
}

/**
 * Owns the call for the whole application.
 *
 * This provider sits above the screen tree, so no route change can unmount the
 * media engine, the signaling socket, or the recorder. Screens render the call
 * or hide it; they never own it. The call is also pinned to the room it was
 * joined in, so browsing another room leaves it running.
 */
export function CallSessionProvider({
  user,
  browsingRoom,
  noise,
  presenceByRoom,
  presenceKnown,
  onError,
  onRequestShare,
  onCallChange,
  children,
}: {
  user: User | null;
  /** The room the sidebar has selected, which the call does not follow. */
  browsingRoom: Room | null;
  noise: boolean;
  presenceByRoom: Record<string, CallParticipant[]>;
  presenceKnown: boolean;
  onError: (message: string) => void;
  onRequestShare: (actions: NativeShareActions) => void;
  /** Reports call state to the shell, which uses it for chrome only. */
  onCallChange?: (chrome: CallChrome) => void;
  children: ReactNode;
}) {
  const [callRoom, setCallRoom] = useState<Room | null>(null);
  const room = callRoom ?? browsingRoom;
  const callPresence = room
    ? (presenceByRoom[room.id] ?? EMPTY_CALL_PRESENCE)
    : EMPTY_CALL_PRESENCE;

  const session = useCallSession({
    user,
    room,
    noise,
    callPresence,
    onError,
    onRequestShare,
  });
  const { joined } = session;

  // Joining pins the call to the room it started in; leaving releases it. The
  // pin is what keeps `room` from following the sidebar mid-call, which is what
  // would otherwise tear the session down.
  useEffect(() => {
    setCallRoom((current) => (joined ? (current ?? browsingRoom) : null));
  }, [joined]);

  useEffect(() => {
    onCallChange?.({ joined, room: joined ? room : null });
  }, [joined, room, onCallChange]);

  return (
    <CallSessionContext.Provider
      value={{ ...session, callRoom, room, callPresence, presenceKnown }}
    >
      {children}
    </CallSessionContext.Provider>
  );
}
