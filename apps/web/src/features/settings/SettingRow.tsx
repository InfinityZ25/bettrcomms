import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One preference: what it is on the left, the control on the right.
 *
 * The control sits in a box of its own with a width, which is what keeps a
 * select from growing to whatever its longest option happens to be and pushing
 * out of the panel. Below the small breakpoint the two stack instead of
 * squeezing each other, since a label and a dropdown do not both fit in 300px.
 */
export function SettingRow({
  title,
  description,
  control,
  as = 'label',
}: {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  as?: 'label' | 'div';
}) {
  const Wrapper = as;
  return (
    <Wrapper
      className={cn(
        'flex flex-col gap-2 border-b border-border/50 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8',
        as === 'label' && 'text-sm',
      )}
    >
      <div className="min-w-0">
        <strong className="block text-sm font-medium">{title}</strong>
        {description && (
          <p className="mt-0.5 max-w-prose text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:w-56 sm:justify-end">
        {control}
      </div>
    </Wrapper>
  );
}

/**
 * A preference whose control needs the full width — a slider, a meter, a row
 * of buttons — so it goes under the label instead of beside it.
 */
export function SettingBlock({
  title,
  description,
  children,
  value,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** The current reading, shown at the end of the title line. */
  value?: ReactNode;
}) {
  return (
    <div className="border-b border-border/50 py-3.5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-4">
        <strong className="text-sm font-medium">{title}</strong>
        {value !== undefined && (
          <output className="text-xs text-muted-foreground tabular-nums">
            {value}
          </output>
        )}
      </div>
      {description && (
        <p className="mt-0.5 max-w-prose text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      )}
      <div className="mt-3">{children}</div>
    </div>
  );
}
