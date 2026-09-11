import { useEffect, useRef, type ReactNode } from 'react';

export default function WorkspaceScreen({
  title,
  description,
  children,
}: {
  title: 'Recordings';
  description: string;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <main
      className="content-canvas flex min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border border-border/60 bg-background shadow-[0_20px_60px_rgb(0_0_0/0.16)]"
      aria-label={title}
    >
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <div className="mx-auto max-w-6xl px-4 pt-6 pb-10 sm:px-8 sm:pt-9 sm:pb-14">
          <div className="mb-8 max-w-2xl">
            <span className="inline-flex rounded-full bg-primary/8 px-3 py-1 text-[0.65rem] font-semibold tracking-[0.16em] text-primary">
              BETTERCOMMS
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
