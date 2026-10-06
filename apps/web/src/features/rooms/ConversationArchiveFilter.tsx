import { Archive, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ConversationArchiveFilter({ archived, count, onChange }: {
  archived: boolean; count: number; onChange: (archived: boolean) => void;
}) {
  return <div className="flex gap-1" role="group" aria-label="Conversation view">
    <Button variant={archived ? 'ghost' : 'secondary'} size="sm" className="min-h-9 flex-1 phone:min-h-11" aria-pressed={!archived} onClick={() => onChange(false)}><MessageSquare size={14} />Active</Button>
    <Button variant={archived ? 'secondary' : 'ghost'} size="sm" className="min-h-9 flex-1 phone:min-h-11" aria-pressed={archived} onClick={() => onChange(true)}><Archive size={14} />Archived{count ? ` (${count})` : ''}</Button>
  </div>;
}
