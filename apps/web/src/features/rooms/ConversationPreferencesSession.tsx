import { useMountEffect } from '@/hooks/useMountEffect';
import { startConversationPreferencesSession } from './conversationPreferences';

export default function ConversationPreferencesSession({ userId }: { userId: string }) {
  useMountEffect(() => startConversationPreferencesSession(userId));
  return null;
}
