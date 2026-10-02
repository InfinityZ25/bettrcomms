import { useSyncExternalStore } from 'react';
import type { User } from '@/api';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { changeOwnPresence, ownPresenceSnapshot, presenceLabels, subscribeOwnPresence, type AccountStatus } from './presenceStore';

const descriptions: Record<AccountStatus, string> = {
  online: 'Available to chat.', idle: 'Show that you are away.',
  dnd: 'Pause message and call alerts on all your devices.', invisible: 'Appear offline to other people. You can still chat and call.',
};
export default function AccountPresenceSelector({ user, compact = false }: { user: User; compact?: boolean }) {
  const own = useSyncExternalStore(subscribeOwnPresence, ownPresenceSnapshot);
  const status = own.userId === user.id ? own.status : user.presence_status ?? 'online';
  const busy = own.userId !== user.id || own.busy;
  return (
    <div className="min-w-0 space-y-2">
      <Select value={status} onValueChange={(value) => { if (value) void changeOwnPresence(user.id, value as AccountStatus); }}>
        <SelectTrigger className="w-full" aria-label="Account status" disabled={busy}><SelectValue>{presenceLabels[status]}</SelectValue></SelectTrigger>
        <SelectContent>
          {(['online', 'idle', 'dnd', 'invisible'] as const).map((value) => <SelectItem key={value} value={value}>{presenceLabels[value]}</SelectItem>)}
        </SelectContent>
      </Select>
      {!compact && <p className="text-xs leading-5 text-muted-foreground">{descriptions[status]} Your status is shared across devices.</p>}
      {own.userId === user.id && own.error && <p role="alert" className="text-xs text-destructive">{own.error}</p>}
    </div>
  );
}
