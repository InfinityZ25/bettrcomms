import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function WorkspaceScreen({
  title,
  description,
  onBack,
  children,
}: {
  title: 'Settings' | 'Recordings';
  description: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <main
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
      aria-label={title}
    >
      <header className="flex min-h-20 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-3 sm:flex-nowrap sm:gap-4 sm:px-7 sm:py-4">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={17} /> Back to call
        </Button>
        <nav className="flex gap-1.5" aria-label="Workspace views">
          <a
            className="rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:px-3.5"
            href="#/"
          >
            Call
          </a>
          <a
            className="rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground sm:px-3.5"
            href="#/recordings"
            aria-current={title === 'Recordings' ? 'page' : undefined}
          >
            Recordings
          </a>
          <a
            className="rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground sm:px-3.5"
            href="#/settings"
            aria-current={title === 'Settings' ? 'page' : undefined}
          >
            Settings
          </a>
        </nav>
      </header>
      <div
        className="min-h-0 flex-1 overflow-auto overscroll-contain"
        data-testid="workspace-scroll"
      >
        <div className="mx-auto max-w-6xl px-4 pt-6 pb-10 sm:px-8 sm:pt-10 sm:pb-14">
          <div className="mb-8">
            <span className="text-[0.65rem] font-semibold tracking-[0.18em] text-muted-foreground">
              YOUR SPACE
            </span>
            <h1
              className="my-2.5 font-heading text-3xl font-semibold tracking-tight outline-none"
              tabIndex={-1}
              ref={heading}
            >
              {title}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
