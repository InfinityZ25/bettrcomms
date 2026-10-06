import { useSyncExternalStore } from 'react';
import { Archive, ArchiveRestore, MoreHorizontal, Star, StarOff } from 'lucide-react';
import type { Room } from '@/api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { isConversationRoom } from '@/features/shell/sections';
import { conversationPreferencesSnapshot, setConversationPreference, subscribeConversationPreferences } from './conversationPreferences';

export default function ConversationPreferenceActions({ room, userId, onError }: {
  room: Room; userId: string; onError: (message: string) => void;
}) {
  const state = useSyncExternalStore(subscribeConversationPreferences, conversationPreferencesSnapshot);
  const preference = state.userId === userId ? state.preferences[room.id] : undefined;
  const label = room.display_name || room.name;
  function choose(patch: { favorite?: boolean; archived?: boolean }) {
    void setConversationPreference(room, patch).catch((error) => onError(error instanceof Error ? error.message : 'Could not update this conversation.'));
  }
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="phone:size-11" aria-label={`Conversation actions for ${label}`} disabled={state.userId !== userId || !state.ready || state.busy[room.id]} />}><MoreHorizontal size={16} /></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem className="phone:min-h-11" onClick={() => choose({ favorite: !preference?.favorite })}>{preference?.favorite ? <StarOff /> : <Star />}{preference?.favorite ? 'Remove from favorites' : 'Add to favorites'}</DropdownMenuItem>
      {isConversationRoom(room.kind) && <DropdownMenuItem className="phone:min-h-11" onClick={() => choose({ archived: !preference?.archived })}>{preference?.archived ? <ArchiveRestore /> : <Archive />}{preference?.archived ? 'Restore conversation' : 'Archive conversation'}</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
