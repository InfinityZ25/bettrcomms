import type { Message } from '@/api';
const linkPattern = /https?:\/\/[^\s<>"']+/gi;
function linkedText(text: string, offset: number) {
  const result: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(linkPattern)) {
    const start = match.index;
    const raw = match[0];
    let url = raw.replace(/[.,!?;:]+$/, '');
    const brackets: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    while (url.length && brackets[url.at(-1)!]) {
      const closing = url.at(-1)!;
      if (url.split(closing).length <= url.split(brackets[closing]).length) break;
      url = url.slice(0, -1);
    }
    url = url.replace(/[.,!?;:]+$/, '');
    if (start > last) result.push(text.slice(last, start));
    try {
      const parsed = new URL(url);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) throw new Error('Invalid URL');
      result.push(<a key={offset + start} href={parsed.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary">{url}</a>);
    } catch {
      result.push(url);
    }
    result.push(raw.slice(url.length));
    last = start + raw.length;
  }
  result.push(text.slice(last));
  return result;
}
export default function PlainMessage({ message }: { message: Message }) {
  const people = new Map(
    message.mentions?.map((person) => [person.id.toLowerCase(), person.name]),
  );
  let offset = 0;
  return (
    <span className="whitespace-pre-wrap">
      {message.body.split(/(<@[0-9a-f-]{36}>)/i).map((part) => {
        const key = offset;
        offset += part.length;
        const name = people.get(part.slice(2, -1).toLowerCase());
        return name ? (
          <span
            key={key}
            // Lime text on its own tint is under 4.5:1 in light, so the light
            // theme uses a deeper ink of the same green.
            className="rounded-md bg-primary/15 px-1 font-medium text-[color-mix(in_oklab,var(--primary)_75%,var(--foreground))] dark:text-primary"
          >
            @{name}
          </span>
        ) : (
          linkedText(part, key)
        );
      })}
    </span>
  );
}
