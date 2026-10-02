import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { api, type Room, type User } from './api';
import { Button } from '@/components/ui/button';
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
import { PresenceSession, useCallPresence } from '@/features/call/useCallPresence';
import { onDesktopNotificationClick } from '@/desktop/notifications';
import MessageThread from '@/features/chat/MessageThread';
import MessageSearch from '@/features/chat/MessageSearch';
import MessagingSession from '@/features/chat/MessagingSession';
import { stopPushForThisBrowser } from '@/features/chat/notificationSettings';
import DirectConversation from '@/features/chat/DirectConversation';
import FriendsDialog from '@/features/friends/FriendsDialog';
import RecordingsLibrary from '@/features/recordings/RecordingsLibrary';
import CreateRoomDialog from '@/features/rooms/CreateRoomDialog';
import RoomSettings from '@/features/rooms/RoomSettings';
import GroupConversationDialog from '@/features/rooms/GroupConversationDialog';
import GroupMembersDialog from '@/features/rooms/GroupMembersDialog';
import JoinInvitation, { EnterInvitation } from '@/features/rooms/JoinInvitation';
import { useInvitation } from '@/features/rooms/useInvitation';
import { useRooms } from '@/features/rooms/useRooms';
import { SettingsDialog } from '@/components/settings-dialog';
import { useCallPreferences } from '@/features/settings/useCallPreferences';
import NativeScreenPicker from '@/features/sharing/NativeScreenPicker';
import ErrorToast from '@/features/shell/ErrorToast';
import RoomSidebar from '@/features/shell/RoomSidebar';
import MobileRoomList from '@/features/shell/MobileRoomList';
import { useAppViewport } from '@/hooks/useAppViewport';
import { useMobileSwipeNavigation } from '@/hooks/useMobileSwipeNavigation';
import { isConversationRoom, sectionForRoom, type Section } from '@/features/shell/sections';
import SpacesRail from '@/features/shell/SpacesRail';
import HomeScreen from '@/features/shell/HomeScreen';
import WorkspaceScreen from '@/features/shell/WorkspaceScreen';
import { readScreen, useScreenRoute } from '@/features/shell/useScreenRoute';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { softSpring } from '@/lib/motion';

export default function App() {
  useAppViewport();
  const phone = useIsMobile();
  const [mobileDestination, setMobileDestination] = useState<
    Section | 'home' | null
  >(null);
  const [error, setError] = useState('');
  const { busy, run } = useAsyncAction(setError);
  const { user, setUser, devAuth, loading, unwrap, signIn } = useSession(() => {
    clear();
    backToCall();
    setSettingsOpen(false);
    setFriendsOpen(false);
    setCreateOpen(false);
    setCreateGroupOpen(false);
    setEnterInvitationOpen(false);
    setInviteRoom(null);
    setSettingsRoom(null);
    setMessageTarget(null);
  });
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
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [enterInvitationOpen, setEnterInvitationOpen] = useState(false);
  const { invitation, chooseInvitation } = useInvitation();
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [mobileBackRevision, markMobileBack] = useState(0);
  const returningOnMobile = () => markMobileBack((value) => value + 1);
  const [settingsRoom, setSettingsRoom] = useState<Room | null>(null);
  const [inviteRoom, setInviteRoom] = useState<Room | null>(null);
  const currentSettingsRoom = rooms.find((candidate) => candidate.id === settingsRoom?.id);
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
  const [shareActions, setShareActions] = useState<NativeShareActions | null>(
    null,
  );
  const shareActionsRef = useRef<NativeShareActions | null>(null);

  // Home is the call screen with nothing selected and no call running.
  const mobileList =
    phone &&
    screen === 'call' &&
    (mobileDestination === 'messages' || mobileDestination === 'calls');
  const atHome =
    screen === 'call' &&
    ((phone && mobileDestination === 'home') ||
      (!room && !callJoined && !mobileList));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = () => setSettingsOpen(true);
  // Which list the sidebar is showing. Selecting a conversation moves the rail
  // with it, so the two never disagree about where you are.
  const [section, setSection] = useState<Section>('calls');
  const showSection = (next: Section) => {
    setSection(next);
    if (phone) setMobileDestination(next);
    navigate('call');
  };
  const openRecordings = () => navigate('recordings');
  const backToCall = () => {
    setMobileDestination(null);
    navigate('call');
  };
  const openHome = () => {
    if (phone) setMobileDestination('home');
    navigate('call');
  };
  /*
    A direct room opens as a conversation and its call is the dock. This says
    the call has been asked for instead; picking any room puts the conversation
    back in front.
  */
  const [callOpen, setCallOpen] = useState(false);
  /*
    Default to chat beside desktop calls and a full stage on phones. Follow
    resizing until the user explicitly opens or closes chat, then keep their
    choice rather than dismissing a conversation during a resize.
  */
  const [chatColumnChoice, setChatColumn] = useState<boolean | null>(null);
  const chatColumn = chatColumnChoice ?? !phone;
  const [channelChat, setChannelChat] = useState(false);
  const [messageTarget, setMessageTarget] = useState<{
    room: string;
    id: string;
  } | null>(null);
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
  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get('open_room');
    if (target && rooms.some((candidate) => candidate.id === target)) {
      openRoomById(target);
      const url = new URL(window.location.href);
      url.searchParams.delete('open_room');
      window.history.replaceState(null, '', url);
    }
    return onDesktopNotificationClick(({ data }) => {
      if (typeof data.roomId === 'string') openRoomById(data.roomId);
    });
  }, [rooms]);
  const selectRoom = (next: Room) => {
    setMobileDestination(null);
    setMessageTarget(null);
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
    if (room && !(phone && mobileDestination))
      setSection(sectionForRoom(room.kind));
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

  const inDirectRoom = Boolean(room && isConversationRoom(room.kind));
  /*
    A direct room has two shapes: the conversation with the whole canvas, and
    the call with the conversation beside it. The call never takes the whole
    canvas here — a call with someone is still a conversation with them.
  */
  const conversation =
    screen === 'call' && !atHome && !mobileList && inDirectRoom && !callOpen;
  const chatBeside =
    screen === 'call' &&
    !atHome &&
    !mobileList &&
    Boolean(room) &&
    (callOpen || !inDirectRoom) &&
    (inDirectRoom ? chatColumn : channelChat);
  const callOnScreen =
    screen === 'call' && !atHome && !mobileList && !conversation;

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
    const failed = (event: Event) =>
      setError((event as CustomEvent<string>).detail);
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
      setUser(
        unwrap(await api<User | { user: User }>('/auth/dev', { email, name })),
      );
    });
  };
  const signOut = () =>
    void run(async () => {
      await stopPushForThisBrowser();
      await api('/auth/logout', {}, 'POST');
      setUser(null);
      clear();
      backToCall();
    });

  const immersive = callJoined && callFocused && screen === 'call';

  useMobileSwipeNavigation({
    enabled: phone && !loading,
    // The native picker owns cancellation and transient capture resources.
    suspended: screen === 'share' || immersive,
    session: user?.id ?? null,
    backRevision: mobileBackRevision,
    value: {
      screen,
      destination: mobileDestination,
      roomId: room?.id ?? null,
      section,
      callOpen,
      channelChat,
      chatColumnChoice,
      settingsOpen,
      friendsOpen,
      inviteRoomId: inviteRoom?.id ?? null,
    },
    valid: (entry) =>
      entry.screen !== 'share' &&
      (!entry.roomId ||
        rooms.some((candidate) => candidate.id === entry.roomId)) &&
      (!entry.inviteRoomId ||
        rooms.some((candidate) => candidate.id === entry.inviteRoomId)),
    restore: (entry) => {
      setMobileDestination(entry.destination);
      setRoom(rooms.find((candidate) => candidate.id === entry.roomId) ?? null);
      setSection(entry.section);
      setCallOpen(entry.callOpen);
      setChannelChat(entry.channelChat);
      setChatColumn(entry.chatColumnChoice);
      setSettingsOpen(entry.settingsOpen);
      setFriendsOpen(entry.friendsOpen);
      setInviteRoom(
        rooms.find((candidate) => candidate.id === entry.inviteRoomId) ?? null,
      );
      // Share is excluded above: restoring these ordinary screens cannot
      // bypass the native picker's hash-change cancellation path.
      setScreen(entry.screen);
      navigate(entry.screen);
    },
  });

  if (loading)
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3">
        <Mascot className="w-24" />
        <span className="text-sm text-muted-foreground">
          Opening your space…
        </span>
      </div>
    );

  return (
    <CallSessionProvider
      user={user}
      browsingRoom={room}
      noise={preferences.noise}
      balanced={preferences.balanced}
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
      {user && <MessagingSession key={`messaging:${user.id}`} userId={user.id} />}
      {user && <PresenceSession key={`presence:${user.id}`} user={user} />}
      {user && (
        <MessageSearch
          user={user}
          rooms={rooms}
          onOpen={(next, id) => {
            selectRoom(next);
            setMessageTarget({ room: next.id, id });
            setChatColumn(true);
            setChannelChat(true);
          }}
        />
      )}
      <div
        data-app-shell
        data-in-call={callJoined}
        data-call-focused={immersive}
        className="app-shell flex h-dvh min-h-0 gap-1.5 overflow-hidden overscroll-none bg-sidebar px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] select-none [[data-desktop-frame]_&]:pt-0"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!callOnScreen && (
            <CallDock
              onOpen={() => {
                setMobileDestination(null);
                setCallOpen(true);
                if (callRoom) setRoom(callRoom);
                navigate('call');
              }}
            />
          )}
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            <main
              className={cn(
                'content-canvas absolute inset-0 min-w-0 flex-col overflow-hidden rounded-3xl border border-border/60 bg-background',
                screen === 'call' && !mobileList ? 'flex' : 'hidden',
              )}
              aria-label="Call"
              hidden={screen !== 'call' || mobileList}
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
                  'call-section relative flex min-w-0 flex-1 flex-col overflow-auto px-3 pt-5 pb-3 [scroll-padding-bottom:1.5rem] min-[481px]:px-5 min-[821px]:pb-0 min-[1251px]:px-8',
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
                {phone && !atHome && !mobileList && !inDirectRoom && room && (
                  <Button
                    className="mobile-room-back mb-2 shrink-0 self-start"
                    variant="ghost"
                    onClick={() => {
                      returningOnMobile();
                      showSection('calls');
                    }}
                    aria-label="Back to rooms"
                  >
                    ← Rooms
                  </Button>
                )}
                {user &&
                  room &&
                  !inDirectRoom &&
                  !callJoined &&
                  !mobileList &&
                  !atHome && (
                    <Button
                      className="absolute top-2 left-5 z-10 phone:right-2 phone:left-auto phone:h-11"
                      variant="secondary"
                      size="sm"
                      aria-label="Toggle room messages"
                      aria-pressed={channelChat}
                      onClick={() => setChannelChat((value) => !value)}
                    >
                      Room messages
                    </Button>
                  )}
                <CallStage
                  hidden={atHome || conversation || mobileList}
                  chatOpen={chatBeside}
                  onChat={
                    room
                      ? () => {
                          if (inDirectRoom)
                            setChatColumn((value) => !(value ?? !phone));
                          else setChannelChat((value) => !value);
                        }
                      : undefined
                  }
                  user={user}
                  layout={preferences.layout}
                  onLayout={preferences.setLayout}
                  focused={callFocused}
                  onFocus={() => setCallFocused((value) => !value)}
                  balanced={preferences.balanced}
                  onError={setError}
                  onInvite={
                    inDirectRoom ? undefined : () => setFriendsOpen(true)
                  }
                />
                {/*
            Beside the call on a wide window, over it on a narrow one: two
            columns need about eleven hundred pixels before the call is left
            with less than it can lay a camera row out in.
          */}
                {chatBeside && room && (
                  <div className="absolute inset-y-0 right-0 z-20 flex w-[min(21rem,calc(100%-2.5rem))] py-1 pr-1 min-[1100px]:static min-[1100px]:w-80 min-[1100px]:shrink-0 min-[1100px]:p-0 phone:z-40 phone:w-full phone:bg-background phone:p-0">
                    {inDirectRoom ? (
                      <DirectConversation
                        room={room}
                        user={user}
                        live={presence.messages}
                        variant="panel"
                        onClose={() => setChatColumn(false)}
                        targetId={
                          messageTarget?.room === room.id
                            ? messageTarget.id
                            : undefined
                        }
                        onCall={() => setCallOpen(true)}
                        onError={setError}
                        onGroupInfo={() => setSettingsRoom(room)}
                      />
                    ) : (
                      user && (
                        <section
                          className="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border bg-background phone:rounded-none phone:border-0"
                          aria-label="Room chat"
                        >
                          <MessageThread
                            key={`${user.id}:${room.id}:${messageTarget?.id ?? ''}`}
                            roomId={room.id}
                            user={user}
                            label={room.name}
                            canModerate={
                              room.kind !== 'direct' &&
                              room.owner_id === user.id
                            }
                            onClose={() => setChannelChat(false)}
                            targetId={
                              messageTarget?.room === room.id
                                ? messageTarget.id
                                : undefined
                            }
                            onError={setError}
                          />
                        </section>
                      )
                    )}
                  </div>
                )}
                {!user && (
                  <div className="space-y-3">
                  {invitation && <p className="rounded-xl border p-3 text-sm">Sign in to review your room invitation. <Button variant="ghost" size="sm" onClick={() => chooseInvitation(null)}>Dismiss invitation</Button></p>}
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
                  </div>
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
                    targetId={
                      messageTarget?.room === room.id
                        ? messageTarget.id
                        : undefined
                    }
                    onBack={
                      phone
                        ? () => {
                            returningOnMobile();
                            showSection('messages');
                          }
                        : undefined
                    }
                    onCall={() => setCallOpen(true)}
                    onError={setError}
                    onGroupInfo={() => setSettingsRoom(room)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
            {mobileList &&
              (mobileDestination === 'messages' ||
                mobileDestination === 'calls') && (
                <div className="absolute inset-0 z-10 flex">
                  <MobileRoomList
                    key={mobileDestination}
                    section={mobileDestination}
                    rooms={rooms}
                    user={user}
                    presence={presence.rooms}
                    known={presence.known}
                    onSelect={selectRoom}
                    onCreate={() => setCreateOpen(true)}
                    onFriends={() => setFriendsOpen(true)}
                    onCreateGroup={() => setCreateGroupOpen(true)}
                    onJoinInvitation={() => setEnterInvitationOpen(true)}
                    onSettings={setSettingsRoom}
                    onInvite={(next) => {
                      setInviteRoom(next);
                      setFriendsOpen(true);
                    }}
                    onChanged={refresh}
                    onError={setError}
                  />
                </div>
              )}
            <AnimatePresence mode="wait" initial={false}>
              {screen === 'recordings' && (
                <motion.div
                  key="recordings"
                  className="absolute inset-0 flex min-w-0"
                  initial={{ opacity: 0, x: 14 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={softSpring}
                >
                  <WorkspaceScreen title="Recordings">
                    <RecordingsLibrary />
                  </WorkspaceScreen>
                </motion.div>
              )}
            </AnimatePresence>
            <SettingsDialog
              open={settingsOpen}
              onOpenChange={(open) => {
                setSettingsOpen(open);
                if (!open) returningOnMobile();
              }}
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
          onCreateGroup={() => setCreateGroupOpen(true)}
          onJoinInvitation={() => setEnterInvitationOpen(true)}
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
          mobileDestination={mobileDestination}
          home={atHome}
          friendsOpen={friendsOpen}
          collapsed={callJoined}
          hidden={immersive}
          onSection={showSection}
          onFriends={() => setFriendsOpen(true)}
          onRecordings={openRecordings}
          onSettings={openSettings}
          onSignOut={signOut}
          onHome={openHome}
        />
        <AnimatePresence>
          {error && (
            <ErrorToast message={error} onDismiss={() => setError('')} />
          )}
        </AnimatePresence>
        <RoomSettings
          room={settingsRoom?.kind === 'group' ? null : settingsRoom}
          user={user}
          open={settingsRoom !== null && settingsRoom.kind !== 'group'}
          onOpenChange={(next) => {
            if (!next) setSettingsRoom(null);
          }}
          onChanged={refresh}
          onError={setError}
          refreshRevision={presence.roomsRevision + presence.syncRevision}
        />
        {user && currentSettingsRoom?.kind === 'group' && <GroupMembersDialog
          key={`${user.id}:${currentSettingsRoom.id}:${currentSettingsRoom.owner_id}`}
          room={currentSettingsRoom}
          user={user} onClose={() => setSettingsRoom(null)} onChanged={refresh}
        />}
        {user && createGroupOpen && <GroupConversationDialog key={user.id} onClose={() => setCreateGroupOpen(false)} onCreated={async (created) => { openRoom(created); selectRoom(created); refresh(); }} />}
        {user && enterInvitationOpen && <EnterInvitation onClose={() => setEnterInvitationOpen(false)} onChoose={(token) => { chooseInvitation(token); setEnterInvitationOpen(false); }} />}
        {user && invitation && <JoinInvitation key={`${user.id}:${invitation}`} token={invitation} onClose={() => chooseInvitation(null)} onJoined={async (joined) => { openRoom(joined); selectRoom(joined); chooseInvitation(null); refresh(); }} />}
        <CreateRoomDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          signedIn={Boolean(user)}
          busy={busy}
          run={run}
          onCreated={async (created) => {
            await reload();
            selectRoom(created);
          }}
        />
        <CallAlerts
          user={user}
          viewing={conversation || chatBeside ? room : null}
          messages={presence.messages}
          onOpenRoom={openRoomById}
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
        {/* Outlives the call screen on purpose: stopping a recording and
          leaving the room tend to be the same moment. */}
        <RecordingNotice onRecordings={openRecordings} />
        <FriendsDialog
          open={friendsOpen}
          onOpenChange={(next) => {
            setFriendsOpen(next);
            if (!next) {
              returningOnMobile();
              setInviteRoom(null);
            }
          }}
          user={user}
          room={inviteRoom ?? room}
          callPresence={presence.rooms}
          onlineUsers={presence.onlineUsers}
          contactStatuses={presence.contactStatuses}
          refreshRevision={presence.friendsRevision + presence.syncRevision}
          onError={setError}
          onOpenRoom={(next) => {
            setMobileDestination(null);
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
