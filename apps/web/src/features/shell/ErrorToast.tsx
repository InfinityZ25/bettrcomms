import { CircleAlert, X } from 'lucide-react';
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
      className="fixed inset-x-4 bottom-6 z-[60] mx-auto flex w-fit max-w-xl items-center gap-3 overflow-hidden rounded-2xl border border-border bc-glass py-3 pr-2.5 pl-5 text-sm font-medium text-popover-foreground before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-destructive phone:top-[calc(env(safe-area-inset-top)+0.5rem)] phone:right-[max(1rem,env(safe-area-inset-right))] phone:bottom-auto phone:left-[max(1rem,env(safe-area-inset-left))] phone:w-auto phone:gap-2 phone:py-2 phone:pr-1.5 phone:pl-4"
      role="alert"
    >
      <CircleAlert size={18} className="shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 leading-5">{message}</span>
      <button
        className="ml-2 grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground phone:ml-0 phone:size-11"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <X size={16} />
      </button>
    </motion.div>
  );
}
