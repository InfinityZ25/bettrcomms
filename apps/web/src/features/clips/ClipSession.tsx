import {
  createContext,
  useCallback,
  useContext,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Scissors, Square } from 'lucide-react';
import type { Room, User } from '@/api';
import { Button } from '@/components/ui/button';
import { AppDialog } from '@/components/app-dialog';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useActiveCall } from '@/features/call/CallSessionContext';
import { ClipBuffer, type ClipWindow } from '@/media/clipBuffer';
import ClipEditor from './ClipEditor';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

interface Draft {
  window: ClipWindow;
  room: Room;
  names: Record<string, string>;
  userId: string;
}
interface ClipSession {
  enabled: boolean;
  duration: number;
  preparing: boolean;
  openConsent: () => void;
  stop: () => void;
  capture: () => Promise<void>;
}
const Context = createContext<ClipSession | null>(null);

export function ClipSessionProvider({
  user,
  children,
}: {
  user: User | null;
  children: ReactNode;
}) {
  const call = useActiveCall();
  const { setClipBuffering } = call;
  const buffer = useRef<ClipBuffer | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [duration, setDuration] = useState(0);
  const [consent, setConsent] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const generation = useRef(0);
  const active = useRef(true);
  const scope = useRef<{ user: string; room: string } | null>(null);

  const stop = useCallback(() => {
    generation.current++;
    const current = buffer.current;
    buffer.current = null;
    scope.current = null;
    void current?.dispose();
    setClipBuffering(false);
    if (active.current) {
      setEnabled(false);
      setDuration(0);
      setPreparing(false);
    }
    if (active.current) setDraft(null);
  }, [setClipBuffering]);
  const openConsent = useCallback(() => setConsent(true), []);
  const closeEditor = useCallback(() => setDraft(null), []);
  function reconcile() {
    const live = call;
    const identity = user;
    const current = buffer.current;
    if (!current || !identity) return;
    current.reconcile([
      ...[...(live.engine?.getLocalTracks() ?? [])].map(([source, track]) => ({
        peerId: identity.id,
        source,
        track,
      })),
      ...(live.engine?.getRemoteTracks() ?? []).map((item) => ({
        peerId: item.peerId,
        source: item.source,
        track: item.track,
      })),
    ]);
    if (buffer.current === current) setDuration(current.durationMs / 1000);
  }
  function start() {
    if (!call.joined || !user) return;
    setError('');
    const next = new ClipBuffer({
      onError: (failure) => {
        if (active.current) {
          setError(failure.message);
          stop();
        }
      },
    });
    buffer.current = next;
    scope.current = { user: user.id, room: call.callRoom?.id ?? call.room!.id };
    setEnabled(true);
    call.setClipBuffering(true);
    setConsent(false);
    reconcile();
  }
  const capture = useCallback(async () => {
    const current = buffer.current;
    if (!current || !call.room || !user || preparing || draft) return;
    const version = generation.current;
    setPreparing(true);
    setError('');
    try {
      const window = await current.snapshot();
      if (active.current && version === generation.current)
        setDraft({
          window,
          room: call.room,
          names: { ...call.names, [user.id]: user.name },
          userId: user.id,
        });
    } catch (failure) {
      if (active.current && version === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (active.current && version === generation.current) setPreparing(false);
    }
  }, [call.room, call.names, user, preparing, draft]);
  const endCapture = useEffectEvent(() => {
    stop();
    setDraft(null);
    setConsent(false);
  });
  const updateCapture = useEffectEvent(() => {
    if (
      !call.joined ||
      (scope.current &&
        (scope.current.user !== user?.id ||
          scope.current.room !== call.callRoom?.id))
    ) {
      if (buffer.current) stop();
      setDraft(null);
      setConsent(false);
    }
    reconcile();
  });
  useMountEffect(() => {
    active.current = true;
    const ended = () => endCapture();
    window.addEventListener('bc-call-ended', ended);
    const timer = setInterval(() => updateCapture(), 300);
    return () => {
      active.current = false;
      clearInterval(timer);
      window.removeEventListener('bc-call-ended', ended);
      stop();
    };
  });
  const session = useMemo<ClipSession>(
    () => ({
      enabled,
      duration,
      preparing,
      openConsent,
      stop,
      capture,
    }),
    [enabled, duration, preparing, openConsent, stop, capture],
  );
  return (
    <Context.Provider value={session}>
      {children}
      <AppDialog
        open={consent}
        onOpenChange={setConsent}
        title="Capture moments with clips"
        description="Keep the latest 90 seconds on this device, then choose the moment to share."
      >
        <div className="space-y-4 text-sm">
          <p>
            Microphones, cameras, screens and shared audio are buffered as
            separate tracks. Everyone in the call sees the recording indicator
            while the buffer runs.
          </p>
          <p className="text-muted-foreground">
            Ask your friends before capturing them. Nothing uploads until you
            publish a clip. Stopping the buffer or leaving the call discards its
            contents.
          </p>
          <Button onClick={start} disabled={!call.joined}>
            <Scissors size={16} /> Enable clip buffer
          </Button>
        </div>
      </AppDialog>
      {error && (
        <AppDialog
          open
          onOpenChange={() => setError('')}
          title="Clip buffer stopped"
          description={error}
        >
          <Button onClick={() => setError('')}>Close</Button>
        </AppDialog>
      )}
      {draft &&
        draft.userId === user?.id &&
        draft.room.id === call.callRoom?.id &&
        call.joined && (
          <ClipEditor
            key={`${draft.userId}:${draft.room.id}:${draft.window.endMs}`}
            window={draft.window}
            room={draft.room}
            names={draft.names}
            onClose={closeEditor}
          />
        )}
    </Context.Provider>
  );
}

export function ClipControls() {
  const clips = useContext(Context);
  const call = useActiveCall();
  if (!clips || !call.joined) return null;
  if (typeof MediaRecorder === 'undefined') return null;
  return (
    <div
      className="flex shrink-0 items-center gap-1"
      aria-label="Clip controls"
    >
      <Button
        variant={clips.enabled ? 'default' : 'secondary'}
        size="icon"
        aria-label={clips.enabled ? 'Create clip' : 'Enable clip buffer'}
        title={
          clips.enabled
            ? `Create a clip from the last ${Math.floor(clips.duration)} seconds`
            : 'Enable clips for this call'
        }
        disabled={clips.preparing || (clips.enabled && clips.duration < 3)}
        onClick={() =>
          clips.enabled ? void clips.capture() : clips.openConsent()
        }
      >
        <Scissors size={17} />
      </Button>
      {clips.enabled && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Stop clip buffer"
          onClick={clips.stop}
        >
          <Square size={13} />
        </Button>
      )}
    </div>
  );
}

export function ClipMenuItems() {
  const clips = useContext(Context);
  if (!clips || typeof MediaRecorder === 'undefined') return null;
  return (
    <>
      <DropdownMenuItem
        disabled={clips.preparing || (clips.enabled && clips.duration < 3)}
        onClick={() =>
          clips.enabled ? void clips.capture() : clips.openConsent()
        }
      >
        <Scissors />
        {clips.enabled ? 'Create clip' : 'Enable clip buffer'}
      </DropdownMenuItem>
      {clips.enabled && (
        <DropdownMenuItem onClick={clips.stop}>
          <Square />
          Stop clip buffer
        </DropdownMenuItem>
      )}
    </>
  );
}
