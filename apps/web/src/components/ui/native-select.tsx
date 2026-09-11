import * as React from 'react';
import { cn } from '@/lib/utils';

/** Keeps native option semantics for media controls while using the preset tokens. */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'h-9 w-full rounded-3xl border border-transparent bg-input/50 px-3 py-1 text-sm outline-none transition-[color,box-shadow,background-color] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
