import { useMountEffect } from '@/hooks/useMountEffect';
import { startMessagingSession } from './messageStore';

export default function MessagingSession({ userId }: { userId: string }) {
  useMountEffect(() => startMessagingSession(userId));
  return null;
}
