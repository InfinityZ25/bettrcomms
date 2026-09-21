import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type Room, type User } from './api';
import { Mascot } from '@/components/mascot';
import { useSession } from '@/features/auth/useSession';
import SignInPanel from '@/features/auth/SignInPanel';
import CallStage, { type NativeShareActions } from '@/features/call/CallStage';
import {
  CallSessionProvider,
  type CallChrome,
} from '@/features/call/CallSessionContext';
import CallDock from '@/features/call/CallDock';
import CallAlerts from '@/features/call/CallAlerts';
import IncomingCall from '@/features/call/IncomingCall';
import RecordingNotice from '@/features/call/RecordingNotice';
import { useCallPresence } from '@/features/call/useCallPresence';
import { onDesktopNotificationClick } from '@/desktop/notifications';
import DirectConversation from '@/features/chat/DirectConversation';
import FriendsDialog from '@/features/friends/FriendsDialog';
import RecordingsLibrary from '@/features/recordings/RecordingsLibrary';
import CreateRoomDialog from '@/features/rooms/CreateRoomDialog';
import RoomSettings from '@/features/rooms/RoomSettings';
import { useRooms } from '@/features/rooms/useRooms';
import { SettingsDialog } from '@/components/settings-dialog';
import { useCallPreferences } from '@/features/settings/useCallPreferences';
import NativeScreenPicker from '@/features/sharing/NativeScreenPicker';
import ErrorToast from '@/features/shell/ErrorToast';
import RoomSidebar from '@/features/shell/RoomSidebar';
import { sectionForRoom, type Section } from '@/features/shell/sections';
import SpacesRail from '@/features/shell/SpacesRail';
import HomeScreen from '@/features/shell/HomeScreen';
import WorkspaceScreen from '@/features/shell/WorkspaceScreen';
import { readScreen, useScreenRoute } from '@/features/shell/useScreenRoute';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { softSpring } from '@/lib/motion';

export default function App() {
  const [error, setError] = useState('');
  const { busy, run } = useAsyncAction(setError);
  const { user, setUser, devAuth, loading, unwrap, signIn } = useSession();
  const presence = useCallPresence(user?.id);
  const { screen, setScreen, navigate } = useScreenRoute();
  const preferences = useCallPreferences();
  const { rooms, room, setRoom, openRoom, reload, refresh, clear } = useRooms(
    user,
    presence.roomsRevision + presence.syncRevision,
    setError,
  );
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [settingsRoom, setSettingsRoom] = useState<Room | null>(null);
  const [inviteRoom, setInviteRoom] = useState<Room | null>(null);
  // Chrome only. The call itself is owned by CallSessionProvider below, which
  // outlives every screen; this is what the shell lays itself out against.
  const [call, setCall] = useState<CallChrome>({
    joined: false,
    room: null,
    recording: false,
  });
  const callJoined = call.joined;
  const callRoom = call.room;
  const [callFocused, setCallFocused] = useState(false);
  const [shareActions, setShareActions] = useState<NativeShareActions | null>(null);
  const shareActionsRef = useRef<NativeShareActions | null>(null);

  // Home is the call screen with nothing selected and no call running.
  const atHome = screen === 'call' && !room && !callJoined;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = () => setSettingsOpen(true);
  // Which list the sidebar is showing. Selecting a conversation moves the rail
  // with it, so the two never disagree about where you are.
  const [section, setSection] = useState<Section>('calls');
  const showSection = (next: Section) => {
    setSection(next);
    navigate('call');
  };
  const openRecordings = () => navigate('recordings');
  const backToCall = () => navigate('call');
  /*
    A direct room opens as a conversation and its call is the dock. This says
    the call has been asked for instead; picking any room puts the conversation
    back in front.
  */
  const [callOpen, setCallOpen] = useState(false);
  /*
    Whether the conversation stays on screen during the call. It does by
    default: pressing Call used to take the entire chat away, with no way back
    to it except the sidebar.
  */
  const [chatColumn, setChatColumn] = useState(true);
  /** Opens a room somebody named rather than picked from the list. */
  const openRoomById = (roomId: string) => {
    const found = rooms.find((candidate) => candidate.id === roomId);
    if (found) selectRoom(found);
  };
  /*
    Clicking a desktop notification. The host brings the window back, which is
    the half the page cannot do; this is the half it cannot: opening what the
    notification was about, so the reply box is already in front of you.
  */
  useEffect(
    () =>
      onDesktopNotificationClick(({ data }) => {
        if (typeof data.roomId === 'string') openRoomById(data.roomId);
      }),
    [rooms],
  );
  const selectRoom = (next: Room) => {
    setRoom(next);
    setSection(sectionForRoom(next.kind));
    setCallOpen(false);
    navigate('call');
  };
  /*
    Rooms are also selected without the sidebar: the first one arrives with the
    list, and a new conversation arrives from the friends dialog. The rail has
    to follow, or the list you are looking at does not contain the room you are
    in — which is how a direct message could be open while the sidebar offered
    to create your first room.
  */
  useEffect(() => {
    if (room) setSection(sectionForRoom(room.kind));
  }, [room?.id]);
  /*
    The end of a call in a conversation hands the screen back to the
    conversation. It used to leave the call's own empty lobby up, offering to
    join the call that had just ended. Watched as a transition rather than as
    a state, so pressing Call — which opens the view before the join lands —
    is not immediately undone.
  */
  const wasInCall = useRef(callJoined);
  useEffect(() => {
    if (wasInCall.current && !callJoined) setCallOpen(false);
    wasInCall.current = callJoined;
  }, [callJoined]);

  const inDirectRoom = Boolean(room && (room.kind ?? 'channel') === 'direct');
  /*
    A direct room has two shapes: the conversation with the whole canvas, and
    the call with the conversation beside it. The call never takes the whole
    canvas here — a call with someone is still a conversation with them.
  */
  const conversation = screen === 'call' && inDirectRoom && !callOpen;
  const chatBeside = screen === 'call' && inDirectRoom && callOpen && chatColumn;
  const callOnScreen = screen === 'call' && !atHome && !conversation;

  const releaseShare = useCallback(() => {
    shareActionsRef.current = null;
    setShareActions(null);
  }, []);

  // Leaving the share screen by any route — hash change, room switch, sign-out —
  // must tear the native capture down with it.
  useEffect(() => {
    const changed = () => {
      const next = readScreen();
      if (screen === 'share' && next !== 'share' && shareActionsRef.current) {
        shareActionsRef.current.onClose();
        releaseShare();
      }
      setScreen(next);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [screen, setScreen, releaseShare]);
  useEffect(() => {
    if (screen === 'share' && !shareActionsRef.current) navigate('call');
  }, [screen]);
  useEffect(() => {
    if (screen === 'share') navigate('call');
  }, [room?.id, user?.id]);

  useEffect(() => {
    const failed = (event: Event) => setError((event as CustomEvent<string>).detail);
    window.addEventListener('bc-output-error', failed);
    return () => window.removeEventListener('bc-output-error', failed);
  }, []);
  useEffect(() => {
    const restore = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !document.fullscreenElement &&
        !document.querySelector('[role="dialog"]')
      )
        setCallFocused(false);
    };
    window.addEventListener('keydown', restore);
    return () => window.removeEventListener('keydown', restore);
  }, []);

  const devSignIn = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setUser(unwrap(await api<User | { user: User }>('/auth/dev', { email, name })));
    });
  };
  const signOut = () =>
    void run(async () => {
      await api('/auth/logout', {}, 'POST');
      setUser(null);
      clear();
      backToCall();
    });

  const immersive = callJoined && callFocused && screen === 'call';

  if (loading)
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3">
        <Mascot className="w-24" />
        <span className="text-sm text-muted-foreground">Opening your space…</span>
      </div>
    );

  return (
    <CallSessionProvider
      user={user}
      browsingRoom={room}
      noise={preferences.noise}
      presenceByRoom={presence.rooms}
      presenceKnown={presence.known}
      onError={setError}
      onCallChange={setCall}
      onRequestShare={(actions) => {
        if (document.fullscreenElement) void document.exitFullscreen();
        shareActionsRef.current = actions;
        setShareActions(actions);
        navigate('share');
      }}
    >
      <div
        data-app-shell
        data-in-call={callJoined}
        data-call-focused={immersive}
        className="app-shell flex h-dvh min-h-[600px] gap-1.5 overflow-hidden bg-sidebar px-2 py-2 min-[821px]:min-h-[680px] select-none [[data-desktop-frame]_&]:pt-0"
      >
      <div className="relative min-w-0 flex-1 overflow-hidden">
      <main
        className={cn(
          'content-canvas absolute inset-0 min-w-0 flex-col overflow-hidden rounded-3xl border border-border/60 bg-background',
          screen === 'call' ? 'flex' : 'hidden',
        )}
        aria-label="Call"
        hidden={screen !== 'call'}
      >
        {/*
          Recording, on the edge of the canvas itself.

          Two sparks leave the record button at the bottom, run up both sides
          and bloom where they meet at the top, leaving a line that breathes
          while it records. It lives here rather than inside the call screen
          because the edge people see is this one: the call's own boxes are all
          inset from it, and a ring floating inside the black read as a box
          around nothing.
        */}
        {call.recording && (
          <div className="recording-frame" aria-hidden="true">
            <span className="recording-frame-meet" />
          </div>
        )}
        <section
          className={cn(
            'relative flex min-w-0 flex-1 flex-col overflow-auto px-3 pt-5 pb-3 [scroll-padding-bottom:1.5rem] min-[481px]:px-5 min-[821px]:pb-0 min-[1251px]:px-8',
            chatBeside && 'min-[1100px]:flex-row min-[1100px]:gap-3',
            callJoined ? 'pt-5' : 'min-[821px]:pt-8',
            callFocused &&
              screen === 'call' &&
              'px-3 pt-4 pb-0 min-[481px]:px-3 min-[821px]:px-3 min-[821px]:pt-4 min-[1251px]:px-3',
          )}
        >
          {/*
            With nothing open there is no call to stage, so home takes the
            space instead of a lobby explaining that nothing is selected. The
            session itself lives above this tree, so nothing is torn down by
            swapping what is on screen.
          */}
          {atHome ? (
            <HomeScreen
              user={user}
              rooms={rooms}
              presence={presence.rooms}
              presenceKnown={presence.known}
              onSelectRoom={selectRoom}
              onCreateRoom={() => setCreateOpen(true)}
              onFriends={() => setFriendsOpen(true)}
              onRecordings={openRecordings}
            />
          ) : null}
          <CallStage
            hidden={atHome || conversation}
            chatOpen={chatBeside}
            onChat={
              inDirectRoom ? () => setChatColumn((value) => !value) : undefined
            }
            user={user}
            layout={preferences.layout}
            onLayout={preferences.setLayout}
            focused={callFocused}
            onFocus={() => setCallFocused((value) => !value)}
            balanced={preferences.balanced}
            onError={setError}
            onInvite={inDirectRoom ? undefined : () => setFriendsOpen(true)}
          />
          {/*
            Beside the call on a wide window, over it on a narrow one: two
            columns need about eleven hundred pixels before the call is left
            with less than it can lay a camera row out in.
          */}
          {chatBeside && room && (
            <div className="absolute inset-y-0 right-0 z-20 flex w-[min(21rem,calc(100%-2.5rem))] py-1 pr-1 min-[1100px]:static min-[1100px]:w-80 min-[1100px]:shrink-0 min-[1100px]:p-0">
              <DirectConversation
                room={room}
                user={user}
                live={presence.messages}
                variant="panel"
                onCall={() => setCallOpen(true)}
                onError={setError}
              />
            </div>
          )}
          {!user && (
            <SignInPanel
              devAuth={devAuth}
              busy={busy}
              name={name}
              email={email}
              onNameChange={setName}
              onEmailChange={setEmail}
              onDevSignIn={devSignIn}
              onSignIn={signIn.start}
              onCancelSignIn={signIn.cancel}
              signInStatus={signIn.status}
            />
          )}
        </section>
      </main>
      <AnimatePresence initial={false}>
        {conversation && room && (
          <motion.div
            key={'conversation-' + room.id}
            className="absolute inset-0 flex min-w-0"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={softSpring}
          >
            <DirectConversation
              room={room}
              user={user}
              live={presence.messages}
              docked={callJoined}
              onCall={() => setCallOpen(true)}
              onError={setError}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence mode="wait" initial={false}>
        {screen === 'recordings' && (
          <motion.div key="recordings" className="absolute inset-0 flex min-w-0" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={softSpring}>
            <WorkspaceScreen title="Recordings">
              <RecordingsLibrary />
            </WorkspaceScreen>
          </motion.div>
        )}
      </AnimatePresence>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        user={user}
        noise={preferences.noise}
        onNoiseChange={preferences.setNoise}
        balanced={preferences.balanced}
        onBalancedChange={preferences.setBalanced}
        layout={preferences.layout}
        onLayoutChange={preferences.setLayout}
        signedIn={Boolean(user)}
        onSignOut={signOut}
      />
      {screen === 'share' && shareActions && (
        <NativeScreenPicker
          onShare={async (options) => {
            await shareActions.onShare(options);
            if (shareActionsRef.current !== shareActions) return;
            releaseShare();
            backToCall();
          }}
          onBrowser={async () => {
            await shareActions.onBrowser();
            if (shareActionsRef.current !== shareActions) return;
            releaseShare();
            backToCall();
          }}
          onClose={backToCall}
        />
      )}
      </div>
      {/*
        The navigation lives on the right. It comes after the content in the DOM
        as well as on screen, so tabbing through the window follows what is
        visible and anything reading the page in order reaches the call first.
      */}
      <RoomSidebar
        rooms={rooms}
        room={room}
        user={user}
        section={section}
        presence={presence.rooms}
        presenceKnown={presence.known}
        screen={screen}
        hidden={immersive}
        onSelectRoom={selectRoom}
        onCreateRoom={() => setCreateOpen(true)}
        onRoomSettings={setSettingsRoom}
        onInviteToRoom={(next) => {
          setInviteRoom(next);
          setFriendsOpen(true);
        }}
        onRoomsChanged={refresh}
        onError={setError}
      />
      <SpacesRail
        user={user}
        screen={screen}
        section={section}
        collapsed={callJoined}
        hidden={immersive}
        onSection={showSection}
        onFriends={() => setFriendsOpen(true)}
        onRecordings={openRecordings}
        onSettings={openSettings}
        onSignOut={signOut}
        onHome={backToCall}
      />
      <AnimatePresence>
        {error && <ErrorToast message={error} onDismiss={() => setError('')} />}
      </AnimatePresence>
      <RoomSettings
        room={settingsRoom}
        user={user}
        open={settingsRoom !== null}
        onOpenChange={(next) => {
          if (!next) setSettingsRoom(null);
        }}
        onChanged={refresh}
        onError={setError}
        refreshRevision={presence.roomsRevision + presence.syncRevision}
      />
      <CreateRoomDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        signedIn={Boolean(user)}
        busy={busy}
        run={run}
        onCreated={async (created) => {
          await reload();
          setRoom(created);
        }}
      />
      <CallAlerts
        user={user}
        viewing={conversation || chatBeside ? room : null}
        messages={presence.messages}
      />
      <IncomingCall
        user={user}
        rooms={rooms}
        presence={presence.rooms}
        onAnswer={(roomId) => {
          openRoomById(roomId);
          // Answering is asking for the call, so the call is what opens; the
          // conversation keeps its column beside it.
          setCallOpen(true);
        }}
      />
      {!callOnScreen && (
        <CallDock
          onOpen={() => {
            setCallOpen(true);
            if (callRoom) setRoom(callRoom);
            navigate('call');
          }}
        />
      )}
      {/* Outlives the call screen on purpose: stopping a recording and
          leaving the room tend to be the same moment. */}
      <RecordingNotice onRecordings={openRecordings} />
      <FriendsDialog
        open={friendsOpen}
        onOpenChange={(next) => {
          setFriendsOpen(next);
          if (!next) setInviteRoom(null);
        }}
        user={user}
        room={inviteRoom ?? room}
        callPresence={presence.rooms}
        onlineUsers={presence.onlineUsers}
        refreshRevision={presence.friendsRevision + presence.syncRevision}
        onError={setError}
        onOpenRoom={(next) => {
          openRoom(next);
          setCallOpen(false);
          setFriendsOpen(false);
          navigate('call');
        }}
        onSignIn={signIn.start}
      />
      </div>
    </CallSessionProvider>
  );
}
