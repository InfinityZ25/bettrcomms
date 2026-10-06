import { useMountEffect } from '@/hooks/useMountEffect';
import { startAccountPreferences } from './accountPreferences';
import { startCustomStatusSession } from './customStatusStore';

export default function AccountPreferencesSession({ userId }: { userId: string }) {
  useMountEffect(() => {
    const stopPreferences = startAccountPreferences(userId);
    const stopStatus = startCustomStatusSession(userId);
    return () => { stopPreferences(); stopStatus(); };
  });
  return null;
}
