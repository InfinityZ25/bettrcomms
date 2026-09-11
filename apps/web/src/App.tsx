import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AudioLines } from 'lucide-react';
import { api, type Room, type User } from './api';
import { useSession } from '@/features/auth/useSession';
import SignInPanel from '@/features/auth/SignInPanel';
import CallStage, { type NativeShareActions } from '@/features/call/CallStage';
import {
  CallSessionProvider,
  type CallChrome,
} from '@/features/call/CallSessionContext';
import { useCallPresence } from '@/features/call/useCallPresence';
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
  const [call, setCall] = useState<CallChrome>({ joined: false, room: null });
  const callJoined = call.joined;
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
  const selectRoom = (next: Room) => {
    setRoom(next);
    setSection(sectionForRoom(next.kind));
    navigate('call');
  };

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
      <div className="flex h-dvh items-center justify-center gap-4 text-primary">
        <AudioLines size={36} />
        <span>Opening your space…</span>
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
        className="app-shell flex h-dvh min-h-[600px] gap-1.5 overflow-hidden bg-sidebar pb-2 px-2 min-[821px]:min-h-[680px] select-none"
      >
      <div className="relative min-w-0 flex-1 overflow-hidden">
      <main
        className={cn(
          'content-canvas absolute inset-0 min-w-0 flex-col overflow-hidden rounded-3xl border border-border/60 bg-background shadow-[0_20px_60px_rgb(0_0_0/0.16)]',
          screen === 'call' ? 'flex' : 'hidden',
        )}
        aria-label="Call"
        hidden={screen !== 'call'}
      >
        <section
          className={cn(
            'flex min-w-0 flex-1 flex-col overflow-auto px-3 pt-5 pb-3 [scroll-padding-bottom:1.5rem] min-[481px]:px-5 min-[821px]:pb-0 min-[1251px]:px-8',
            callJoined ? 'pt-5' : 'min-[821px]:pt-8',
            callFocused &&
              screen === 'call' &&
              'p-0 min-[481px]:p-0 min-[821px]:p-0 min-[1251px]:p-0',
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
            hidden={atHome}
            user={user}
            layout={preferences.layout}
            onLayout={preferences.setLayout}
            focused={callFocused}
            onFocus={() => setCallFocused((value) => !value)}
            balanced={preferences.balanced}
            onError={setError}
            onInvite={() => setFriendsOpen(true)}
            onRecordings={openRecordings}
          />
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
      <AnimatePresence mode="wait" initial={false}>
        {screen === 'recordings' && (
          <motion.div key="recordings" className="absolute inset-0 flex min-w-0" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={softSpring}>
            <WorkspaceScreen title="Recordings" description="Watch, listen and export your saved calls.">
              <RecordingsLibrary />
            </WorkspaceScreen>
          </motion.div>
        )}
      </AnimatePresence>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
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
        hiddenInCall={callJoined}
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
        onOpenRoom={openRoom}
        onSignIn={signIn.start}
      />
      </div>
    </CallSessionProvider>
  );
}
