import { CircleHelp, X } from 'lucide-react';
import { motion } from 'motion/react';
import { spring } from '@/lib/motion';
import { useIsMobile } from '@/hooks/use-mobile';

/**
 * The single app-wide failure notice.
 *
 * Centred by stretching between both edges and taking its own width, not by
 * sitting at the midpoint and translating back: a box anchored at `left: 50%`
 * is only offered half the screen, which wrapped phone notices into a column
 * one word wide. On a phone it drops from the top, under the status bar,
 * because the bottom holds the call controls and the tab bar it used to cover.
 */
export default function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const phone = useIsMobile();
  const offset = phone ? -18 : 18;
  return (
    <motion.div
      initial={{ opacity: 0, y: offset, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: offset * 0.66, scale: 0.97 }}
      transition={spring}
      className="fixed inset-x-4 bottom-6 z-[60] mx-auto flex w-fit max-w-xl items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm text-card-foreground shadow-2xl phone:top-[calc(env(safe-area-inset-top)+0.5rem)] phone:bottom-auto phone:w-auto phone:gap-2 phone:py-2 phone:pr-1.5 phone:pl-3"
      role="alert"
    >
      <CircleHelp size={18} className="shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        className="ml-3 grid shrink-0 place-items-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground phone:ml-0 phone:size-10"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <X size={16} />
      </button>
    </motion.div>
  );
}
