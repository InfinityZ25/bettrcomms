import { useMountEffect } from '@/hooks/useMountEffect';
import { refreshCachedProfiles, startMessagingSession } from './messageStore';
import { subscribeProfiles } from '@/features/settings/profileStore';
import { startNotificationSession } from './notificationSettings';
import { startPersonalSession } from '@/features/personal/personalStore';
import { startDraftSession } from '@/features/personal/draftStore';
import { startReminderAttention } from '@/features/personal/reminderAttention';

export default function MessagingSession({ userId }: { userId: string }) {
  useMountEffect(() => {
    const stopMessaging = startMessagingSession(userId);
    const stopNotifications = startNotificationSession(userId);
    const stopProfiles = subscribeProfiles(refreshCachedProfiles);
    const stopPersonal = startPersonalSession(userId);
    const stopDrafts = startDraftSession(userId);
    const stopAttention = startReminderAttention(userId);
    return () => { stopAttention(); stopDrafts(); stopPersonal(); stopProfiles(); stopMessaging(); stopNotifications(); };
  });
  return null;
}
