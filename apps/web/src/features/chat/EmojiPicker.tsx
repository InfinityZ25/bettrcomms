import { useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import raw from './emoji/catalog.json';
import { emojiTones, findEmojis, normalizeEmojiSearch, type EmojiEntry, type EmojiTone } from './emojiCatalog';
import { clearRecentEmojis, readEmojiTone, readRecentEmojis, rememberEmoji, saveEmojiTone } from './emojiPreferences';

const entries: EmojiEntry[] = raw.entries.map(([emoji, name, category]) => ({ emoji: String(emoji), name: String(name), category: Number(category), search: normalizeEmojiSearch(String(name)) }));
const PAGE_SIZE = 80;
const byEmoji = new Map(entries.map((entry) => [entry.emoji, entry]));
export default function EmojiPicker(props: { onSelect: (emoji: string) => void; onClose: () => void; userId?: string }) {
  return <AccountEmojiPicker key={props.userId ?? 'anonymous'} {...props} />;
}

function AccountEmojiPicker({ onSelect, onClose, userId }: { onSelect: (emoji: string) => void; onClose: () => void; userId?: string }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(-1);
  const [page, setPage] = useState(0);
  const [recent, setRecent] = useState(() => readRecentEmojis(userId));
  const [tone, setTone] = useState<EmojiTone>(() => readEmojiTone(userId));
  const [focusedIndex, setFocusedIndex] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const recentEntries = recent.map((emoji) => byEmoji.get(emoji)).filter((entry): entry is EmojiEntry => Boolean(entry));
  const found = findEmojis(category === -2 ? recentEntries : entries, query, category, tone);
  const visible = found.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  function resetPage() { setPage(0); setFocusedIndex(0); }
  function select(emoji: string) { rememberEmoji(userId, emoji); onSelect(emoji); }
  function changePage(next: number, focusGrid = false) {
    setPage(next);
    setFocusedIndex(0);
    if (focusGrid) requestAnimationFrame(() => buttons.current[0]?.focus());
  }
  return <AppDialog open onOpenChange={(open) => { if (!open) onClose(); }} title="Choose emoji" description="Search names, browse categories or use arrow keys to select an emoji." className="flex max-h-[85dvh] flex-col sm:max-w-md">
    <div><label className="text-xs" htmlFor={searchId}>Search emojis</label><div className="relative mt-1"><input ref={search} id={searchId} type="search" maxLength={80} aria-label="Search emojis" value={query} className="w-full rounded-lg border bg-background p-2 pr-9 text-sm" onChange={(event) => { setQuery(event.target.value); resetPage(); }} onKeyDown={(event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); buttons.current[0]?.focus(); }
      else if (event.key === 'Enter' && visible.length) { event.preventDefault(); select(visible[0].emoji); }
    }} />{query && <Button type="button" variant="ghost" size="icon-sm" className="absolute top-1 right-1" aria-label="Clear emoji search" onClick={() => { setQuery(''); resetPage(); search.current?.focus(); }}><X size={14} /></Button>}</div></div>
    <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-xs">Category<select aria-label="Emoji category" value={category} className="mt-1 w-full max-w-full rounded-lg border bg-background p-2" onChange={(event) => { setCategory(Number(event.target.value)); resetPage(); }}><option value={-1}>All emojis</option>{userId && <option value={-2}>Recently used</option>}{raw.groups.map((group, index) => <option key={group} value={index}>{group}</option>)}</select></label><label className="min-w-0 flex-1 text-xs">Skin tone<select aria-label="Emoji skin tone" value={tone} className="mt-1 w-full max-w-full rounded-lg border bg-background p-2" onChange={(event) => { const next = event.target.value as EmojiTone; setTone(next); saveEmojiTone(userId, next); resetPage(); }}>{emojiTones.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>
    {recentEntries.length > 0 && category !== -2 && !query && <div><div className="mb-1 flex items-center justify-between text-xs"><span className="text-muted-foreground">Recently used</span><Button type="button" variant="ghost" size="sm" aria-label="Clear recent emojis" onClick={() => { clearRecentEmojis(userId); setRecent([]); }}>Clear</Button></div><div className="flex max-h-20 flex-wrap gap-0.5" aria-label="Recently used emojis">{recentEntries.slice(0, 16).map((entry) => <button type="button" key={entry.emoji} aria-label={`Recent emoji ${entry.name}`} title={entry.name} className="size-9 rounded-lg text-2xl hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => select(entry.emoji)}>{entry.emoji}</button>)}</div></div>}
    <div className="min-h-0 overflow-y-auto" aria-label="Emoji results">
      <div className="grid grid-cols-8 gap-0.5">{visible.map((entry, index) => <button ref={(node) => { buttons.current[index] = node; }} key={entry.emoji} type="button" tabIndex={focusedIndex === index ? 0 : -1} aria-label={`Emoji ${entry.name}`} title={entry.name} className="aspect-square min-h-9 rounded-lg text-2xl hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onFocus={() => setFocusedIndex(index)} onClick={() => select(entry.emoji)} onKeyDown={(event) => {
        const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[event.key];
        if (offset !== undefined) { event.preventDefault(); buttons.current[Math.max(0, Math.min(visible.length - 1, index + offset))]?.focus(); }
        else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); buttons.current[event.key === 'Home' ? 0 : visible.length - 1]?.focus(); }
        else if (event.key === 'PageDown' && (page + 1) * PAGE_SIZE < found.length) { event.preventDefault(); changePage(page + 1, true); }
        else if (event.key === 'PageUp' && page > 0) { event.preventDefault(); changePage(page - 1, true); }
      }}>{entry.emoji}</button>)}</div>
      {!found.length && <p className="py-8 text-center text-sm text-muted-foreground">{category === -2 && !recent.length ? 'Your recent emojis will appear here after you use them.' : 'No matching emojis.'}</p>}
    </div>
    <div className="flex items-center justify-between gap-2 text-xs"><Button type="button" size="sm" variant="ghost" disabled={!page} onClick={() => changePage(page - 1)}>Previous</Button><span role="status">{found.length} results · page {page + 1}/{Math.max(1, Math.ceil(found.length / PAGE_SIZE))}</span><Button type="button" size="sm" variant="ghost" disabled={(page + 1) * PAGE_SIZE >= found.length} onClick={() => changePage(page + 1)}>Next</Button></div>
  </AppDialog>;
}
