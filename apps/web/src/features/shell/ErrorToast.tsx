import { CircleHelp, X } from 'lucide-react';
import { motion } from 'motion/react';
import { spring } from '@/lib/motion';

/** The single app-wide failure notice. */
export default function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.97 }}
      transition={spring}
      className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 z-[60] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm text-card-foreground shadow-2xl"
      role="alert"
    >
      <CircleHelp size={18} className="shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
      <button
        className="ml-3 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <X size={16} />
      </button>
    </motion.div>
  );
}
