import { useRef, useState, useSyncExternalStore } from 'react';
import { Hand, PartyPopper, ThumbsUp } from 'lucide-react';
import { api, ApiRequestError, type User } from '@/api';
import { Companion } from '@/components/companion';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { usePetSettings } from '@/features/pet/petSettings';
import { useMountEffect } from '@/hooks/useMountEffect';
import {
  characterGestureConnectionSnapshot,
  subscribeCharacterGestureConnection,
  type CharacterGestureKind,
} from './characterGestureStore';

const gestures = [
  { kind: 'wave', label: 'Wave', Icon: Hand },
  { kind: 'nod', label: 'Nod', Icon: ThumbsUp },
  { kind: 'celebrate', label: 'Celebrate', Icon: PartyPopper },
] as const;

export default function ComposerCompanion({
  user, roomId, threadRootId, blocked, onError,
}: {
  user: User;
  roomId: string;
  threadRootId?: string;
  blocked: boolean;
  onError: (message: string) => void;
}) {
  const lifetime = useLifetimeSignal();
  // With the screen companion sitting right above this button, a second copy
  // of the same creature inside it is redundant; the button becomes the hand.
  const { enabled: companionOnScreen } = usePetSettings();
  const connected = useSyncExternalStore(
    subscribeCharacterGestureConnection, characterGestureConnectionSnapshot,
  );
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [cooldown, setCooldown] = useState(false);
  const cooldownUntil = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [sent, setSent] = useState('');
  const unavailable = blocked || !connected || pending || cooldown;
  useMountEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
  });
  const startCooldown = (milliseconds: number) => {
    cooldownUntil.current = Date.now() + milliseconds;
    setCooldown(true);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (!lifetime().aborted) { setCooldown(false); setSent(''); }
    }, milliseconds);
  };
  const sendGesture = async (gesture: CharacterGestureKind) => {
    if (unavailable || pendingRef.current || Date.now() < cooldownUntil.current) return;
    const signal = lifetime();
    if (signal.aborted) return;
    pendingRef.current = true;
    setPending(true);
    setSent('');
    try {
      await api(`/rooms/${roomId}/character-gesture`, {
        gesture, ...(threadRootId ? { thread_root_id: threadRootId } : {}),
      }, 'POST', signal);
      if (signal.aborted) return;
      startCooldown(3000);
      const label = gestures.find((item) => item.kind === gesture)?.label ?? 'Gesture';
      setSent(`${label} sent.`);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiRequestError && error.retryAfter) {
        startCooldown(Math.min(60_000, Math.max(3000, error.retryAfter * 1000)));
      }
      onError(error instanceof Error ? error.message : 'Could not send your character gesture.');
    } finally {
      pendingRef.current = false;
      if (!signal.aborted) setPending(false);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button type="button" variant="ghost" size="icon" className="size-11 rounded-xl" />}
          aria-label="Character gestures"
          title={!connected ? 'Character gestures reconnect when the conversation is online.' : 'Send a character gesture'}
          disabled={unavailable}
        >
          {companionOnScreen
            ? <Hand className="size-5 text-muted-foreground" aria-hidden="true" />
            : <Companion userId={user.id} name={user.name} character={user.character} className="size-10 phone:size-8" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Your character</DropdownMenuLabel>
            {gestures.map(({ kind, label, Icon }) => (
              <DropdownMenuItem key={kind} className="min-h-11" disabled={unavailable} onClick={() => { void sendGesture(kind); }}>
                <Icon /> {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span role="status" className="sr-only">{pending ? 'Sending character gesture…' : sent}</span>
    </>
  );
}
