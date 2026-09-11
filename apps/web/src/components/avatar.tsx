import { useEffect, useState } from 'react';
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

/**
 * Only a picture the identity provider vouched for is loaded.
 *
 * An avatar URL arrives from the API, and rendering one is a request this
 * application makes to somewhere else: it tells that host who is looking and
 * when. WorkOS serves its own and proxies the providers', so that is the one
 * origin worth trusting with it. Anything else falls back to initials, which
 * is what a missing picture looks like anyway.
 */
const TRUSTED_AVATAR_HOST = /(^|\.)workoscdn\.com$/i;

export function trustedAvatar(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    return TRUSTED_AVATAR_HOST.test(parsed.hostname) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function Avatar({
  name,
  src,
  size = 'sm',
  from = 'words',
  className,
}: {
  name: string;
  /** The profile picture the identity provider supplied, if there is one. */
  src?: string | null;
  size?: 'sm' | 'lg';
  from?: 'words' | 'leading';
  className?: string;
}) {
  const source = trustedAvatar(src);
  // A picture that will not load must not leave a blank square where a name
  // should be, so failure falls back to the initials underneath.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [source]);

  const letters = from === 'leading' ? leadingInitials(name) : initials(name);
  const shape = size === 'lg' ? 'size-14 rounded-full text-xl' : 'size-8 rounded-xl text-xs';

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-muted font-semibold text-muted-foreground',
        shape,
        className,
      )}
    >
      {letters}
      {source && !broken && (
        <img
          src={source}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          // The provider's CDN gets no page address along with the request.
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full object-cover"
          onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}
