import { useEffect, useState } from 'react';
import { Blobatar } from '@blobatar/react';
import { thinking } from 'blobatar/expression';
import { PresenceAvatar, type PresenceState } from '@/components/ui/presence-avatar';
import { blobatarFor } from '@/features/settings/blobatarIdentity';
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
 * origin worth trusting with it. Anything else falls back to a face, which is
 * what a missing picture looks like anyway.
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

/**
 * Somebody's face.
 *
 * Two things can stand for a person here: the photo their identity provider
 * has, and the blobatar drawn from their account. Whoever has a photo shows it,
 * with their creature kept as a small mark in the corner — the photo is who
 * they are, the creature is who they are *here*, and losing the second one
 * entirely for everybody with a Google account would make the room half as
 * recognisable. `prefer` swaps which of the two is large.
 */
export function Avatar({
  name,
  id,
  src,
  size = 'sm',
  prefer = 'photo',
  presence,
  speaking = false,
  className,
}: {
  name: string;
  /**
   * The account this face belongs to, when it is known. A blobatar is drawn
   * from the string it is given, so an id keeps somebody's face theirs when
   * they change their display name.
   */
  id?: string | null;
  /** The profile picture the identity provider supplied, if there is one. */
  src?: string | null;
  size?: 'sm' | 'lg';
  /** Which of the two is the big one. Only matters when there is a photo. */
  prefer?: 'photo' | 'face';
  /**
   * Whether they are around, where the surrounding UI actually knows. Left out
   * everywhere else: a dot that is always green is not presence, it is
   * decoration that looks like presence.
   */
  presence?: PresenceState;
  /**
   * Talking right now.
   *
   * The face wears the library's `thinking` pose while it lasts — the eyes go
   * up and away, which is what somebody mid-sentence looks like. It is the
   * expression alone: the three-dot indicator that presence-avatar pairs with
   * its own thinking *state* means "a task is running", which this is not.
   */
  speaking?: boolean;
  className?: string;
}) {
  const source = trustedAvatar(src);
  // A picture that will not load must not leave a blank square where a name
  // should be, so failure falls back to the face underneath.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [source]);

  const face = blobatarFor(id ?? name);
  const photo = source && !broken;
  const photoLeads = photo && prefer === 'photo';

  const creature = presence ? (
    <PresenceAvatar
      name={face.name}
      label={name}
      state={presence}
      blobatar={{
        hue: face.hue,
        expression: speaking ? thinking : undefined,
      }}
      className="size-full"
    />
  ) : (
    <Blobatar
      name={face.name}
      hue={face.hue}
      animate="always"
      expression={speaking ? thinking : undefined}
      title={photoLeads ? undefined : name}
      aria-hidden={photoLeads ? 'true' : undefined}
      className="size-full"
    />
  );

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center',
        size === 'lg' ? 'size-14' : 'size-8',
        className,
      )}
    >
      {photoLeads ? (
        <>
          <img
            src={source}
            alt={name}
            loading="lazy"
            decoding="async"
            // The provider's CDN gets no page address along with the request.
            referrerPolicy="no-referrer"
            className="size-full rounded-xl bg-muted object-cover"
            onError={() => setBroken(true)}
          />
          {/* The corner a silhouette never reaches into, and a ring of the page
              behind it so the mark separates from whatever the photo is. */}
          <span className="pointer-events-none absolute -right-[8%] -bottom-[8%] size-[42%] rounded-full bg-background p-[6%] ring-1 ring-border">
            {creature}
          </span>
        </>
      ) : (
        <>
          {creature}
          {photo && (
            <img
              src={source}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="pointer-events-none absolute -right-[8%] -bottom-[8%] size-[42%] rounded-full bg-background object-cover ring-1 ring-border"
              onError={() => setBroken(true)}
            />
          )}
        </>
      )}
    </span>
  );
}
