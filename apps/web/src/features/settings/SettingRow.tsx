import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A titled preference with its control on the right. */
export function SettingRow({
  title,
  description,
  control,
  as = 'label',
}: {
  title: string;
  description: string;
  control: ReactNode;
  as?: 'label' | 'div';
}) {
  const Wrapper = as;
  return (
    <Wrapper
      className={cn(
        'flex min-h-14 items-center justify-between gap-5 py-2',
        as === 'label' && 'text-sm',
      )}
    >
      <div>
        <strong className="text-sm">{title}</strong>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      {control}
    </Wrapper>
  );
}
