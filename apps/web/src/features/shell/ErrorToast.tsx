import { CircleHelp, X } from 'lucide-react';

/** The single app-wide failure notice. */
export default function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed bottom-6 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm text-card-foreground shadow-2xl"
      role="alert"
    >
      <CircleHelp size={18} />
      {message}
      <button
        className="ml-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <X size={16} />
      </button>
    </div>
  );
}
