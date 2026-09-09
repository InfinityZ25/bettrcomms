import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** An action that reads as a link: used inside settings cards and status blocks. */
export function LinkButton({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
