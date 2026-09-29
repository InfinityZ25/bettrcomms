import { useMountEffect } from '@/hooks/useMountEffect';
import { startMessagingSession } from './messageStore';
import { startNotificationSession } from './notificationSettings';

export default function MessagingSession({ userId }: { userId: string }) {
  useMountEffect(() => {
    const stopMessaging = startMessagingSession(userId);
    const stopNotifications = startNotificationSession(userId);
    return () => { stopMessaging(); stopNotifications(); };
  });
  return null;
}
