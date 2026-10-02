import { useCallback, useEffectEvent, useRef, useState, type SetStateAction } from 'react';
import { api, type User } from '@/api';
import { useWorkOSSignIn } from './useWorkOSSignIn';
import { useMountEffect } from '@/hooks/useMountEffect';
import { setSessionIdentity, subscribeSessionExpiry } from './sessionEvents';
import { profileRevision, profileSnapshot, reconcileProfile, subscribeProfiles } from '@/features/settings/profileStore';

const unwrap = (result: User | { user: User }) => 'user' in result ? result.user : result;

export function useSession(onExpired?: () => void) {
  const [user, setUserState] = useState<User | null>(null);
  const [devAuth, setDevAuth] = useState(false);
  const [loading, setLoading] = useState(true);
  const request = useRef<AbortController | undefined>(undefined);
  const currentUser = useRef(user);
  const revision = useRef(0);
  const expirationHandler = useEffectEvent(() => onExpired?.());
  const setUser = useCallback((next: SetStateAction<User | null>) => {
    revision.current += 1;
    request.current?.abort();
    const value = typeof next === 'function' ? next(currentUser.current) : next;
    currentUser.current = value;
    setSessionIdentity(value?.id ?? null);
    setUserState(value);
  }, []);
  const refresh = useCallback(async () => {
    const operation = ++revision.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const revisions = new Map(Object.keys(profileSnapshot()).map((id) => [id, profileRevision(id)]));
    try {
      const result = unwrap(await api<User | { user: User }>('/me', undefined, undefined, controller.signal));
      if (!controller.signal.aborted && operation === revision.current) {
        const profile = reconcileProfile(result, revisions.get(result.id) ?? 0);
        currentUser.current = profile;
        setSessionIdentity(profile.id);
        setUserState(profile);
      }
    } catch { /* Authentication errors invalidate the session centrally. */ }
  }, []);
  const signIn = useWorkOSSignIn(refresh);
  useMountEffect(() => {
    let stopped = false;
    const stopProfiles = subscribeProfiles(() => {
      const profile = currentUser.current && profileSnapshot()[currentUser.current.id];
      if (profile) { currentUser.current = profile; setUserState(profile); }
    });
    const stopExpiry = subscribeSessionExpiry(() => {
      revision.current += 1;
      request.current?.abort();
      currentUser.current = null;
      setUserState(null);
      expirationHandler();
    });
    api<{ dev_auth: boolean }>('/config')
      .then((config) => { if (!stopped) setDevAuth(config.dev_auth); })
      .catch(() => {});
    refresh().finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; revision.current += 1; request.current?.abort(); stopProfiles(); stopExpiry(); };
  });
  return { user, setUser, devAuth, loading, unwrap, signIn };
}
