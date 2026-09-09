import { LayoutPanelTop } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** The signed-out introduction above the call stage. */
export default function WelcomeBanner({ onToggleLayout }: { onToggleLayout: () => void }) {
  return (
    <div className="mb-5 flex items-center justify-between min-[481px]:mb-7">
      <div>
        <span className="text-[0.6rem] font-semibold tracking-[0.18em] text-muted-foreground">
          MAKE ROOM FOR YOUR PEOPLE
        </span>
        <h1 className="mt-3 font-heading text-2xl font-semibold tracking-tight min-[481px]:text-[clamp(1.5rem,2.1vw,2.125rem)]">
          A little closer, wherever.
        </h1>
        <p className="mt-3 max-w-96 text-xs leading-6 text-muted-foreground min-[481px]:text-sm">
          Clear conversations. Beautiful streams. A space that feels like yours.
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Layout settings"
        onClick={onToggleLayout}
      >
        <LayoutPanelTop size={20} />
      </Button>
    </div>
  );
}
