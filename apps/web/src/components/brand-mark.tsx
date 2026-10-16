import { cn } from '@/lib/utils';

/**
 * The Bettercomms mark: the six bars of the app icon's waveform.
 *
 * Drawn in `currentColor` so it sits on any surface. With `live` the bars
 * move like a voice meter — used where something is actually happening
 * (a call in progress), never as idle decoration. Reduced motion stops them.
 */
const BARS = [
  { x: 112, y: 216, h: 80 },
  { x: 164, y: 168, h: 176 },
  { x: 216, y: 112, h: 288 },
  { x: 268, y: 144, h: 224 },
  { x: 320, y: 184, h: 144 },
  { x: 372, y: 224, h: 64 },
] as const;

export function BrandMark({
  className,
  live = false,
}: {
  className?: string;
  live?: boolean;
}) {
  return (
    <svg
      viewBox="96 96 320 320"
      className={cn('size-5', className)}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {BARS.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="28"
          height={bar.h}
          rx="14"
          className={live ? 'animate-bc-wave' : undefined}
          style={
            live
              ? {
                  transformBox: 'fill-box',
                  transformOrigin: 'center',
                  animationDelay: `${index * -0.17}s`,
                }
              : undefined
          }
        />
      ))}
    </svg>
  );
}

/**
 * The app icon itself: the mark on a lime squircle, lit from above like the
 * primary button so the two read as the same material.
 */
export function BrandTile({
  className,
  live = false,
}: {
  className?: string;
  live?: boolean;
}) {
  return (
    <span
      className={cn(
        'grid size-10 shrink-0 place-items-center rounded-[30%] bg-brand bg-[linear-gradient(180deg,oklch(1_0_0/0.16),transparent_55%)] text-brand-foreground shadow-[var(--glow-brand),inset_0_1px_0_oklch(1_0_0/0.4),inset_0_-1px_0_oklch(0_0_0/0.12)]',
        className,
      )}
      aria-hidden="true"
    >
      <BrandMark className="size-[62%]" live={live} />
    </span>
  );
}

/** The name, set in the display face, with the "comms" half in the brand colour. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'font-heading text-lg leading-none font-extrabold tracking-tight',
        className,
      )}
    >
      better<span className="text-primary">comms</span>
    </span>
  );
}
