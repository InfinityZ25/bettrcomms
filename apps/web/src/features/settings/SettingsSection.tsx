import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';

/**
 * One card in a settings page.
 *
 * It does not animate. Every section used to fade and rise on mount with a
 * stagger, which meant switching settings tabs replayed the whole page as a
 * cascade — a transition on top of the dialog's own, for a surface people open
 * to change one value and leave. Settings is a form, and a form should be
 * readable the instant it appears.
 */
export function SettingsSection({ id, icon, title, description, children }: {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6" aria-labelledby={`${id}-title`}>
      <Card className="settings-card gap-0 py-0">
        <CardHeader className="border-b border-border/60 py-5">
          <div className="flex items-start gap-3.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-muted text-foreground">{icon}</span>
            <div className="min-w-0 pt-0.5">
              <h3 id={`${id}-title`} className="text-[0.95rem] font-semibold tracking-tight">{title}</h3>
              <CardDescription className="mt-1 text-xs leading-5">{description}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="settings-card-content py-5">{children}</CardContent>
      </Card>
    </section>
  );
}
