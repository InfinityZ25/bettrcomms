import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** An action that reads as a link: used inside settings cards and status blocks. */
export function LinkButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="link"
      size="sm"
      className={cn(
        'my-1 h-auto justify-start px-0 text-xs',
        className,
      )}
      {...props}
    />
  );
}
