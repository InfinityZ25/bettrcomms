import { LayoutPanelTop } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** The signed-out introduction above the call stage. */
export default function WelcomeBanner({ onToggleLayout }: { onToggleLayout: () => void }) {
  return (
    <div className="mb-5 flex items-center justify-between animate-bc-rise min-[481px]:mb-7">
      <div>
        <span className="bc-kicker">
          MAKE ROOM FOR YOUR PEOPLE
        </span>
        <h1 className="mt-3 font-heading text-3xl font-extrabold tracking-tight bc-gradient-text min-[481px]:text-[clamp(1.75rem,2.6vw,2.5rem)]">
          A little closer, wherever.
        </h1>
        <p className="mt-3 max-w-96 text-sm leading-6 text-muted-foreground min-[481px]:text-[0.9375rem]">
          Clear conversations. Beautiful streams. A space that feels like yours.
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-xl text-muted-foreground hover:text-foreground"
        aria-label="Layout settings"
        onClick={onToggleLayout}
      >
        <LayoutPanelTop size={20} />
      </Button>
    </div>
  );
}
