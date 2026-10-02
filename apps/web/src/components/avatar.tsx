import { useCallback, useState, useSyncExternalStore } from 'react';
import { Blobatar } from '@blobatar/react';
import { thinking } from 'blobatar/expression';
import { PresenceAvatar, type PresenceState } from '@/components/ui/presence-avatar';
import { blobatarFor } from '@/features/settings/blobatarIdentity';
import { cn } from '@/lib/utils';
import { avatarApiPath, avatarSnapshot, subscribeAvatar } from '@/features/settings/avatarCache';

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
export type AvatarProps = {
  name: string;
  id?: string | null;
  src?: string | null;
  size?: 'sm' | 'lg';
  prefer?: 'photo' | 'face';
  presence?: PresenceState;
  speaking?: boolean;
  className?: string;
};
export function Avatar(props: AvatarProps) {
  // Changing an image resets its failure state without synchronizing React state.
  return <AvatarContent key={props.src ?? ''} {...props} />;
}
function AvatarContent({
  name,
  id,
  src,
  size = 'sm',
  prefer = 'photo',
  presence,
  speaking = false,
  className,
}: AvatarProps) {
  const path = avatarApiPath(src);
  const subscribe = useCallback((listener: () => void) => path ? subscribeAvatar(path, listener) : () => {}, [path]);
  const snapshot = useCallback(() => path ? avatarSnapshot(path) : undefined, [path]);
  const cached = useSyncExternalStore(subscribe, snapshot, () => undefined);
  const source = path ? cached : trustedAvatar(src);
  // A picture that will not load must not leave a blank square where a name
  // should be, so failure falls back to the face underneath.
  const [broken, setBroken] = useState(false);

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
