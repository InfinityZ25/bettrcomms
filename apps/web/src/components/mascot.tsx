import { Blobatar } from '@blobatar/react';
import { cn } from '@/lib/utils';

/**
 * The BetterComms mascot.
 *
 * A blobatar is a pure function of its name and traits, so these two values
 * *are* the character — change one letter of the name and a different creature
 * appears, with a different silhouette, palette and face. They live here, in
 * one place, so every screen shows the same one and nobody has to guess the
 * seed to draw it again.
 *
 * Animation needs `blobatar/motion.css`, which styles.css imports. Without it
 * the face renders perfectly and never moves.
 */
const MASCOT_NAME = 'Reddy';
const MASCOT_TRAITS = { tone: 0.1, hue: 0.708 } as const;

export function Mascot({
  className,
  title,
}: {
  /** Sets the size: the drawing fills whatever width it is given. */
  className?: string;
  /**
   * An accessible name. Left out where the mascot is decoration beside text
   * that already says what is going on, which is most places.
   */
  title?: string;
}) {
  return (
    <div className={cn('w-24', className)} aria-hidden={title ? undefined : true}>
      <Blobatar
        name={MASCOT_NAME}
        traits={MASCOT_TRAITS}
        animate="always"
        title={title}
      />
    </div>
  );
}
