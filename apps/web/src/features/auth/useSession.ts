import { useEffect, useState } from 'react';
import { api, type User } from '@/api';

const unwrap = (result: User | { user: User }) =>
  'user' in result ? result.user : result;

/** The signed-in user, plus whether this deployment offers the local sign-in form. */
export function useSession() {
  const [user, setUser] = useState<User | null>(null);
  const [devAuth, setDevAuth] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ dev_auth: boolean }>('/config')
      .then((config) => setDevAuth(config.dev_auth))
      .catch(() => {});
    api<User | { user: User }>('/me')
      .then((result) => setUser(unwrap(result)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { user, setUser, devAuth, loading, unwrap };
}

export const signInWithWorkOS = () => location.assign('/api/v1/auth/login');
