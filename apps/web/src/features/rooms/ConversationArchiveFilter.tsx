import { Archive, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ConversationArchiveFilter({ archived, count, onChange }: {
  archived: boolean; count: number; onChange: (archived: boolean) => void;
}) {
  // One segmented control: the pressed view is a raised segment in a shared well.
  return <div className="flex gap-1 rounded-xl border border-border bg-sidebar-accent/40 p-1" role="group" aria-label="Conversation view">
    <Button variant={archived ? 'ghost' : 'secondary'} size="sm" className="min-h-9 flex-1 rounded-lg text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground dark:hover:bg-sidebar-accent/70 aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[var(--shadow-soft),var(--highlight)] aria-pressed:hover:bg-card dark:aria-pressed:hover:bg-card phone:min-h-11" aria-pressed={!archived} onClick={() => onChange(false)}><MessageSquare size={14} />Active</Button>
    <Button variant={archived ? 'secondary' : 'ghost'} size="sm" className="min-h-9 flex-1 rounded-lg text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground dark:hover:bg-sidebar-accent/70 aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[var(--shadow-soft),var(--highlight)] aria-pressed:hover:bg-card dark:aria-pressed:hover:bg-card phone:min-h-11" aria-pressed={archived} onClick={() => onChange(true)}><Archive size={14} />Archived{count ? ` (${count})` : ''}</Button>
  </div>;
}
