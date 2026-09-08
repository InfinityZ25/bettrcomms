import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const variants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium transition-colors outline-none disabled:pointer-events-none disabled:opacity-50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        secondary:
          'border-border bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost:
          'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        danger: 'bg-destructive text-white shadow-xs hover:bg-destructive/90',
      },
      size: {
        default: 'h-10 px-4 py-2',
        icon: 'size-10 p-0',
        sm: 'h-8 gap-1.5 px-3 text-xs',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);
export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof variants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp className={cn(variants({ variant, size }), className)} {...props} />
  );
}
