import { Headphones, Mic, MicOff, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { roomLabel } from '@/features/rooms/RoomNavigation';
import { useActiveCall } from './CallSessionContext';

/**
 * The live call, when the screen is being used for something else.
 *
 * Opening a conversation while a call is running used to hide the call
 * outright: no roster, no mute, no way out except going back to it. This is the
 * whole call reduced to what you need while you are reading something else —
 * where it is, whether your microphone is open, and the way back in — so the
 * space it was occupying can be the conversation.
 */
export default function CallDock({ onOpen }: { onOpen: () => void }) {
  const call = useActiveCall();
  const { joined, callRoom, peers, microphone } = call;
  if (!joined) return null;

  const others = Object.keys(peers).length;
  const name = callRoom ? roomLabel(callRoom) : 'Call';

  return (
    <div className="fixed bottom-3 left-3 z-30 flex items-center gap-1 rounded-2xl border border-border bg-card/95 p-1.5 shadow-[0_14px_36px_rgb(0_0_0/0.3)] backdrop-blur">
      {/* The label is the way back, so the pill reads as one thing you can
          press rather than a bar with a button on it. */}
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-1 text-left hover:bg-accent"
        aria-label={`Back to the call in ${name}`}
      >
        <span className="relative grid size-7 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
          <Headphones size={15} />
          <span className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-primary" />
        </span>
        <span className="min-w-0">
          <strong className="block max-w-32 truncate text-xs font-semibold">
            {name}
          </strong>
          <span className="text-[0.6rem] text-muted-foreground">
            {others
              ? `${others + 1} in the call`
              : 'Waiting for your people'}
          </span>
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={microphone.muted ? 'Unmute microphone' : 'Mute microphone'}
        aria-pressed={microphone.muted}
        onClick={call.toggleMute}
      >
        {microphone.muted ? (
          <MicOff size={15} className="text-destructive" />
        ) : (
          <Mic size={15} />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-destructive"
        aria-label="Leave call"
        onClick={call.leave}
      >
        <PhoneOff size={15} />
      </Button>
    </div>
  );
}
