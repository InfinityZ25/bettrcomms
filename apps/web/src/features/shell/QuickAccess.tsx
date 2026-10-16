import { lazy, Suspense, useEffectEvent, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMountEffect } from '@/hooks/useMountEffect';
import { quickAccessEvent } from './quickAccessEvents';
import {
  isQuickAccessShortcut,
  type QuickDestination,
} from './quickAccessModel';
import { hasBlockingOverlay } from './shortcutGuards';

const QuickAccessResults = lazy(() => import('./QuickAccessResults'));

/** Modal subscriptions are account-scoped by the host's user key. No persistent search history. */
export default function QuickAccess({
  userId,
  revision,
  enabled,
  onNavigate,
}: {
  userId: string;
  revision: string;
  enabled: boolean;
  onNavigate: (destination: QuickDestination) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(true);
  const show = useEffectEvent(() => {
    if (!enabled || hasBlockingOverlay()) return;
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    restoreFocus.current = true;
    setQuery('');
    setOpen(true);
  });
  const keyboard = useEffectEvent((event: KeyboardEvent) => {
    if (!isQuickAccessShortcut(event)) return;
    if (open) {
      event.preventDefault();
      return;
    }
    if (!enabled || hasBlockingOverlay()) return;
    event.preventDefault();
    show();
  });
  useMountEffect(() => {
    const shortcut = (event: KeyboardEvent) => keyboard(event);
    const requested = () => show();
    window.addEventListener('keydown', shortcut);
    window.addEventListener(quickAccessEvent, requested);
    return () => {
      window.removeEventListener('keydown', shortcut);
      window.removeEventListener(quickAccessEvent, requested);
    };
  });
  const navigate = (destination: QuickDestination) => {
    restoreFocus.current = false;
    setOpen(false);
    onNavigate(destination);
  };
  return (
    <Dialog open={open && enabled} onOpenChange={setOpen}>
      <DialogContent
        data-quick-access
        className="flex max-h-[min(42rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[38rem] [&>[data-slot=dialog-close]]:top-3.5 [&>[data-slot=dialog-close]]:right-3.5 [&>[data-slot=dialog-close]]:size-11"
        initialFocus={input}
        finalFocus={() =>
          restoreFocus.current && opener.current?.isConnected
            ? opener.current
            : false
        }
      >
        <div className="flex shrink-0 flex-col gap-1 px-5 pt-5 pr-16 pb-4">
          <DialogTitle>Quick access</DialogTitle>
          <DialogDescription>
            Jump to your people, conversations and settings.
          </DialogDescription>
        </div>
        {open && enabled && (
          <Suspense
            fallback={
              <p
                role="status"
                className="px-5 pb-5 text-sm text-muted-foreground"
              >
                Opening quick access…
              </p>
            }
          >
            <QuickAccessResults
              userId={userId}
              revision={revision}
              query={query}
              onQueryChange={setQuery}
              inputRef={input}
              onNavigate={navigate}
            />
          </Suspense>
        )}
      </DialogContent>
    </Dialog>
  );
}
