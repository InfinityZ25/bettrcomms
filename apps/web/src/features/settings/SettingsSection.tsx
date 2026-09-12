import type { ReactNode } from 'react';

/**
 * One group of preferences on a settings page.
 *
 * This used to be a card: a rounded panel with a shadow, a rounded tile with
 * an icon in it, a title and a sentence describing the page — under a dialog
 * header that already said which page you were on, with the same sentence
 * behind an info tooltip beside it. Three ways of saying "Audio" above two
 * switches. Settings is a form, so this is a form: the page's own heading
 * names it, and everything below is the list of things you can change.
 */
export function SettingsSection({
  id,
  title,
  children,
}: {
  id: string;
  /** Named for assistive technology; the visible title is the page header. */
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="sr-only">
        {title}
      </h3>
      {children}
    </section>
  );
}
