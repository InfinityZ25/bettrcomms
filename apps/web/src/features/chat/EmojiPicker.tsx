import { useRef, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import raw from './emoji/catalog.json';
import { findEmojis, normalizeEmojiSearch, type EmojiEntry } from './emojiCatalog';

const entries: EmojiEntry[] = raw.entries.map(([emoji, name, category]) => ({ emoji: String(emoji), name: String(name), category: Number(category), search: normalizeEmojiSearch(String(name)) }));
const PAGE_SIZE = 80;
export default function EmojiPicker({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(-1);
  const [page, setPage] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const found = findEmojis(entries, query, category);
  const visible = found.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return <AppDialog open onOpenChange={(open) => { if (!open) onClose(); }} title="Choose emoji" description="Search names, browse categories or use arrow keys to select an emoji." className="flex max-h-[85dvh] flex-col sm:max-w-md">
    <label className="text-xs">Search emojis<input type="search" maxLength={80} aria-label="Search emojis" value={query} className="mt-1 w-full rounded-lg border bg-background p-2" onChange={(event) => { setQuery(event.target.value); setPage(0); }} onKeyDown={(event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); buttons.current[0]?.focus(); }
      else if (event.key === 'Enter' && visible.length) { event.preventDefault(); onSelect(visible[0].emoji); }
    }} /></label>
    <label className="text-xs">Category<select aria-label="Emoji category" value={category} className="ml-2 max-w-full rounded-lg border bg-background p-2" onChange={(event) => { setCategory(Number(event.target.value)); setPage(0); }}><option value={-1}>All emojis</option>{raw.groups.map((group, index) => <option key={group} value={index}>{group}</option>)}</select></label>
    <div className="min-h-0 overflow-y-auto" aria-label="Emoji results">
      <div className="grid grid-cols-8 gap-0.5">{visible.map((entry, index) => <button ref={(node) => { buttons.current[index] = node; }} key={entry.emoji} type="button" aria-label={`Emoji ${entry.name}`} title={entry.name} className="aspect-square min-h-9 rounded-lg text-2xl hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(entry.emoji)} onKeyDown={(event) => {
        const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[event.key];
        if (offset !== undefined) { event.preventDefault(); buttons.current[Math.max(0, Math.min(visible.length - 1, index + offset))]?.focus(); }
      }}>{entry.emoji}</button>)}</div>
      {!found.length && <p className="py-8 text-center text-sm text-muted-foreground">No matching emojis.</p>}
    </div>
    <div className="flex items-center justify-between gap-2 text-xs"><Button size="sm" variant="ghost" disabled={!page} onClick={() => setPage(page - 1)}>Previous</Button><span role="status">{found.length} results · page {page + 1}/{Math.max(1, Math.ceil(found.length / PAGE_SIZE))}</span><Button size="sm" variant="ghost" disabled={(page + 1) * PAGE_SIZE >= found.length} onClick={() => setPage(page + 1)}>Next</Button></div>
  </AppDialog>;
}
