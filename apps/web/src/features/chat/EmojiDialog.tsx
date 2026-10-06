import { lazy, Suspense } from 'react';
const EmojiPicker = lazy(() => import('./EmojiPicker'));
export default function EmojiDialog(props: { onSelect: (emoji: string) => void; onClose: () => void; userId?: string }) {
  return <Suspense fallback={<p role="status" className="p-2 text-xs">Loading emojis…</p>}><EmojiPicker {...props} /></Suspense>;
}
