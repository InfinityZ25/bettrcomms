import { cn } from '@/lib/utils';

/** "Ada Lovelace" → "AL". Used wherever a full name is known. */
export const initials = (name: string) =>
  name
    .split(' ')
    .map((word) => word[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

/** "Friend" → "FR". Used for call peers, whose label may be a single word. */
export const leadingInitials = (name: string) => name.slice(0, 2).toUpperCase();

export function Avatar({
  name,
  size = 'sm',
  from = 'words',
  className,
}: {
  name: string;
  size?: 'sm' | 'lg';
  from?: 'words' | 'leading';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-muted font-semibold text-muted-foreground',
        size === 'lg'
          ? 'size-14 rounded-full text-xl'
          : 'size-8 rounded-xl text-xs',
        className,
      )}
    >
      {from === 'leading' ? leadingInitials(name) : initials(name)}
    </span>
  );
}
