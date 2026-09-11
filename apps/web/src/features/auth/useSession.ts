import { useCallback, useEffect, useState } from 'react';
import { api, type User } from '@/api';
import { useWorkOSSignIn } from './useWorkOSSignIn';

const unwrap = (result: User | { user: User }) =>
  'user' in result ? result.user : result;

/** The signed-in user, plus whether this deployment offers the local sign-in form. */
export function useSession() {
  const [user, setUser] = useState<User | null>(null);
  const [devAuth, setDevAuth] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(
    () =>
      api<User | { user: User }>('/me')
        .then((result) => setUser(unwrap(result)))
        .catch(() => {}),
    [],
  );

  // Sign-in lives here rather than in the panels because the session it
  // produces does. On the desktop host the browser finishes somewhere else
  // entirely, so whoever started it, this is what notices and loads the user.
  const signIn = useWorkOSSignIn(refresh);

  useEffect(() => {
    api<{ dev_auth: boolean }>('/config')
      .then((config) => setDevAuth(config.dev_auth))
      .catch(() => {});
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  return { user, setUser, devAuth, loading, unwrap, signIn };
}
