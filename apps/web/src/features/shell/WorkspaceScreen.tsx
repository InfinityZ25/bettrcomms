import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The frame a full-screen section is drawn in.
 *
 * It used to open with a lettered brand pill, a three-line heading and a
 * sentence explaining the page below it — the shape of a landing page, on a
 * screen somebody reached by clicking "Recordings". The heading stays, because
 * moving focus to it is how the section announces itself; the marketing around
 * it is gone, and the page's own first line can be about the contents.
 */
export default function WorkspaceScreen({
  title,
  children,
}: {
  title: 'Recordings';
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
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain" data-testid="workspace-scroll">
        <div className="mx-auto max-w-6xl px-4 pt-5 pb-10 sm:px-8 sm:pt-7 sm:pb-14">
          <h1
            className="mb-4 font-heading text-xl font-semibold tracking-tight outline-none"
            tabIndex={-1}
            ref={heading}
          >
            {title}
          </h1>
          {children}
        </div>
      </div>
    </main>
  );
}
