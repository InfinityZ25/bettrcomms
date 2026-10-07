import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { CallParticipant, Room, User } from '@/api';
import { useCallSession } from './useCallSession';
import { RemoteAudio } from './PeerAudio';
import { CopilotNativeOverlay } from './CopilotNativeOverlay';
import { useMountEffect } from '@/hooks/useMountEffect';
import {
  EMPTY_CALL_PRESENCE,
  type CallPresence,
  type NativeShareActions,
  type JoinMode,
} from './callTypes';

/**
 * The live call, plus the room bookkeeping that keeps it anchored.
 *
 * `room` is what the call screen renders. It is the room the call was joined
 * in for as long as the call is live, and the browsed room otherwise.
 */
export type CallSession = Omit<ReturnType<typeof useCallSession>, 'join'> & {
  /** An explicit join targets the browsed room unless another target is supplied. */
  join: (mode?: JoinMode, target?: Room | null) => Promise<boolean>;
  /** The room the live call belongs to. Null when no call is live. */
  callRoom: Room | null;
  room: Room | null;
  callPresence: CallPresence[];
  presenceKnown: boolean;
  setAudibleShareIds: (ids: string[]) => void;
};

/** What the shell needs to know about the call to lay itself out. */
export type CallChrome = {
  joined: boolean;
  room: Room | null;
  /** The shell draws the recording frame, which is the canvas's own edge. */
  recording: boolean;
};

const CallSessionContext = createContext<CallSession | null>(null);

function CallIdentityScope({ onLeave }: { onLeave: () => void }) {
  useMountEffect(() => () => onLeave());
  return null;
}

function CallChromeReporter({
  chrome,
  onChange,
}: {
  chrome: CallChrome;
  onChange?: (chrome: CallChrome) => void;
}) {
  useMountEffect(() => {
    onChange?.(chrome);
  });
  return null;
}

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
  balanced,
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
  balanced: boolean;
  presenceByRoom: Record<string, CallParticipant[]>;
  presenceKnown: boolean;
  onError: (message: string) => void;
  onRequestShare: (actions: NativeShareActions) => void;
  /** Reports call state to the shell, which uses it for chrome only. */
  onCallChange?: (chrome: CallChrome) => void;
  children: ReactNode;
}) {
  const [callRoom, setCallRoom] = useState<Room | null>(null);
  const [audibleShareIds, setAudibleShareIds] = useState<string[]>([]);
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
    onRoomChange: (next) => {
      setCallRoom(next);
      setAudibleShareIds([]);
    },
  });
  const { joined } = session;
  const latestSession = useRef(session);
  latestSession.current = session;
  const join = (
    mode: JoinMode = 'replace',
    target: Room | null = browsingRoom,
  ) => session.join(mode, target);

  return (
    <CallSessionContext.Provider
      value={{
        ...session,
        join,
        callRoom,
        room,
        callPresence,
        presenceKnown,
        setAudibleShareIds,
      }}
    >
      <CallIdentityScope
        key={user?.id ?? 'signed-out'}
        onLeave={() => latestSession.current.leave()}
      />
      <CallChromeReporter
        key={`${joined}:${joined ? (room?.id ?? '') : ''}:${session.recording}`}
        chrome={{
          joined,
          room: joined ? room : null,
          recording: session.recording,
        }}
        onChange={onCallChange}
      />
      {session.joined && session.engine && (
        <CopilotNativeOverlay
          copilot={session.engine.copilot}
          names={session.names}
        />
      )}
      {session.remote
        .filter(
          (track) =>
            track.track.kind === 'audio' &&
            (track.source === 'microphone' ||
              (track.source === 'system' &&
                audibleShareIds.includes(track.peerId))),
        )
        .map((track) => (
          <RemoteAudio
            key={track.peerId + track.source + track.track.id}
            track={track.track}
            peerId={track.peerId}
            source={track.source}
            balanced={balanced}
          />
        ))}
      {children}
    </CallSessionContext.Provider>
  );
}
