import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** A checkbox drawn as a track and knob, used for the on/off preferences. */
export function Switch({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      className={cn(
        "relative m-0 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full border bg-input p-0 transition-colors before:absolute before:top-[3px] before:left-[3px] before:size-3 before:rounded-full before:bg-foreground before:transition-[left] before:content-[''] checked:border-primary checked:bg-primary checked:before:left-[17px] checked:before:bg-primary-foreground",
        className,
      )}
      {...props}
    />
  );
}
