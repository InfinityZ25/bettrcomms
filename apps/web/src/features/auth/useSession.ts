import { useCallback, useRef, useState, type SetStateAction } from 'react';
import { api, type User } from '@/api';
import { useWorkOSSignIn } from './useWorkOSSignIn';
import { useMountEffect } from '@/hooks/useMountEffect';
import { profileRevision, profileSnapshot, reconcileProfile, subscribeProfiles } from '@/features/settings/profileStore';

const unwrap = (result: User | { user: User }) =>
  'user' in result ? result.user : result;

/** The signed-in user, plus whether this deployment offers the local sign-in form. */
export function useSession() {
  const [user, setUserState] = useState<User | null>(null);
  const [devAuth, setDevAuth] = useState(false);
  const [loading, setLoading] = useState(true);
  const request = useRef<AbortController | undefined>(undefined);
  const revision = useRef(0);
  const setUser = useCallback((next: SetStateAction<User | null>) => {
    revision.current += 1;
    request.current?.abort();
    setUserState(next);
  }, []);

  const refresh = useCallback(
    async () => {
      const operation = ++revision.current;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const revisions = new Map(Object.keys(profileSnapshot()).map((id) => [id, profileRevision(id)]));
      try {
        const result = unwrap(await api<User | { user: User }>('/me', undefined, undefined, controller.signal));
        if (!controller.signal.aborted && operation === revision.current) setUserState(reconcileProfile(result, revisions.get(result.id) ?? 0));
      } catch { /* A signed-out or unavailable session stays on the sign-in screen. */ }
    },
    [],
  );

  // Sign-in lives here rather than in the panels because the session it
  // produces does. On the desktop host the browser finishes somewhere else
  // entirely, so whoever started it, this is what notices and loads the user.
  const signIn = useWorkOSSignIn(refresh);

  useMountEffect(() => {
    let stopped = false;
    const unsubscribe = subscribeProfiles(() => {
      setUserState((current) => current && profileSnapshot()[current.id] ? profileSnapshot()[current.id] : current);
    });
    api<{ dev_auth: boolean }>('/config')
      .then((config) => { if (!stopped) setDevAuth(config.dev_auth); })
      .catch(() => {});
    refresh().finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; revision.current += 1; request.current?.abort(); unsubscribe(); };
  });

  return { user, setUser, devAuth, loading, unwrap, signIn };
}
