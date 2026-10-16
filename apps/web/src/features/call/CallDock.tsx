import { Mic, MicOff, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/brand-mark';
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
    <div className="call-dock fixed bottom-3 left-3 z-30 flex items-center gap-1 rounded-full border border-border bc-glass p-1.5 pr-2 animate-bc-rise phone:static phone:shrink-0 phone:animate-none phone:rounded-none phone:border-x-0 phone:border-t-0 phone:shadow-none phone:[&>button:first-child]:flex-1">
      {/* The label is the way back, so the pill reads as one thing you can
          press rather than a bar with a button on it. */}
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-3 pl-1 text-left transition-colors hover:bg-foreground/8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring phone:rounded-xl"
        aria-label={`Back to the call in ${name}`}
      >
        <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground shadow-[var(--glow-brand)]">
          <BrandMark live className="size-[18px]" />
          <span className="absolute -top-0.5 -right-0.5 size-2.5 animate-bc-pulse rounded-full bg-online ring-2 ring-popover" />
        </span>
        <span className="min-w-0">
          <strong className="block max-w-32 truncate text-[0.8125rem] leading-tight font-semibold phone:max-w-none phone:text-sm">
            {name}
          </strong>
          <span className="text-[0.6875rem] text-muted-foreground tabular-nums phone:text-xs">
            {others
              ? `${others + 1} in the call`
              : 'Waiting for your people'}
          </span>
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className={
          'size-9 shrink-0 rounded-full phone:size-11 ' +
          (microphone.muted
            ? 'bg-dnd/15 hover:bg-dnd/25 dark:hover:bg-dnd/25'
            : 'bg-foreground/8 hover:bg-foreground/14 dark:hover:bg-foreground/14')
        }
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
        className="size-9 shrink-0 rounded-full bg-[oklch(0.56_0.2_25)] text-white shadow-[0_8px_20px_-10px_oklch(0.56_0.2_25)] hover:bg-[oklch(0.62_0.2_25)] hover:text-white dark:hover:bg-[oklch(0.62_0.2_25)] phone:size-11"
        aria-label="Leave call"
        onClick={call.leave}
      >
        <PhoneOff size={15} />
      </Button>
    </div>
  );
}
