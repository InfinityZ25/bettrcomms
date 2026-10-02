import { useMountEffect } from '@/hooks/useMountEffect';
import { refreshCachedProfiles, startMessagingSession } from './messageStore';
import { subscribeProfiles } from '@/features/settings/profileStore';
import { startNotificationSession } from './notificationSettings';

export default function MessagingSession({ userId }: { userId: string }) {
  useMountEffect(() => {
    const stopMessaging = startMessagingSession(userId);
    const stopNotifications = startNotificationSession(userId);
    const stopProfiles = subscribeProfiles(refreshCachedProfiles);
    return () => { stopProfiles(); stopMessaging(); stopNotifications(); };
  });
  return null;
}
