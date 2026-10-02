import { useCallback, useState } from 'react';
import { useMountEffect } from '@/hooks/useMountEffect';
import { invitationToken, pendingInvitation, rememberInvitation } from './invitationLink';

export function useInvitation() {
  const [token, setToken] = useState(pendingInvitation);
  const choose = useCallback((next: string | null) => {
    rememberInvitation(next);
    setToken(next);
  }, []);
  useMountEffect(() => {
    if (token) rememberInvitation(token);
    const changed = () => {
      const next = invitationToken(window.location.href);
      if (next) choose(next);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  });
  return { invitation: token, chooseInvitation: choose };
}
