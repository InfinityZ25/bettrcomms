import { Children, isValidElement, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '@/api';
import { safeMessageURL } from './messageFormatting';

type Node = { type: string; value?: string; children?: Node[]; data?: { hName: string; hProperties?: Record<string, unknown> } };

// Work on parsed text nodes: code, link destinations and raw HTML never receive
// mention/spoiler substitution. HTML stays visible as escaped text.
function messageNodes(people: Map<string, string>) {
  return () => (tree: Node) => {
    function visit(parent: Node) {
      if (!parent.children || parent.type === 'code' || parent.type === 'inlineCode') return;
      parent.children = parent.children.flatMap((node): Node[] => {
        if (node.type === 'html') return [{ type: 'text', value: node.value }];
        if (node.type !== 'text') { visit(node); return [node]; }
        const value = node.value ?? '';
        const result: Node[] = [];
        let last = 0;
        for (const match of value.matchAll(/<@[0-9a-f-]{36}>/gi)) {
          const name = people.get(match[0].slice(2, -1).toLowerCase());
          if (!name) continue;
          if (match.index > last) result.push({ type: 'text', value: value.slice(last, match.index) });
          result.push({ type: 'messageInline', data: { hName: 'span', hProperties: { 'data-mention': true } }, children: [{ type: 'text', value: '@' + name }] });
          last = match.index + match[0].length;
        }
        result.push({ type: 'text', value: value.slice(last) });
        return result;
      });
      const pieces = parent.children.flatMap((node) => node.type === 'text' ? (node.value ?? '').split(/(\|\|)/).filter(Boolean).map((value): Node => ({ type: value === '||' ? 'spoilerDelimiter' : 'text', value })) : [node]);
      const delimiters = pieces.map((node, index) => node.type === 'spoilerDelimiter' ? index : -1).filter((index) => index >= 0);
      if (!delimiters.length) return;
      const combined: Node[] = [];
      let cursor = 0;
      for (let index = 0; index + 1 < delimiters.length; index += 2) {
        const start = delimiters[index]; const end = delimiters[index + 1];
        combined.push(...pieces.slice(cursor, start));
        combined.push({ type: 'messageInline', data: { hName: 'span', hProperties: { 'data-spoiler': true } }, children: pieces.slice(start + 1, end) });
        cursor = end + 1;
      }
      combined.push(...pieces.slice(cursor).map((node) => node.type === 'spoilerDelimiter' ? { type: 'text', value: '||' } : node));
      parent.children = combined;
    }
    visit(tree);
  };
}

function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return <span><button type="button" aria-label={revealed ? 'Hide spoiler' : 'Reveal spoiler'} aria-expanded={revealed}
    className="rounded bg-muted px-1 text-left align-baseline focus-visible:ring-2 focus-visible:ring-ring"
    onClick={() => setRevealed(!revealed)}><span aria-hidden="true">{revealed ? 'Hide' : '[spoiler]'}</span></button>{revealed && <span className="ml-1">{children}</span>}</span>;
}

function textContent(node: ReactNode): string {
  return Children.toArray(node).map((child) => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? textContent(child.props.children) : '').join('');
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [feedback, setFeedback] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(textContent(children));
      setFeedback('Copied');
    } catch { setFeedback('Select the code to copy it.'); }
  };
  return <div className="my-2 overflow-hidden rounded-lg border bg-muted/60">
    <div className="flex items-center justify-between px-3 py-1 text-xs text-muted-foreground"><span>Code</span>
      <button type="button" className="min-h-8 px-2 underline" onClick={() => { void copy(); }}>Copy code</button></div>
    <pre className="max-h-80 max-w-full overflow-auto p-3 font-mono text-xs leading-5">{children}</pre>
    {feedback && <p role="status" className="px-3 pb-2 text-xs">{feedback}</p>}
  </div>;
}

export default function FormattedMessage({ message }: { message: Message }) {
  const people = new Map(message.mentions?.map((person) => [person.id.toLowerCase(), person.name]));
  return <Markdown key={message.body} remarkPlugins={[remarkGfm, messageNodes(people)]} urlTransform={safeMessageURL}
    components={{
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-primary underline underline-offset-2 hover:no-underline">{children}</a> : <>{children}</>,
      img: ({ alt }) => <span>{alt ? `[image: ${alt}]` : '[image]'}</span>,
      p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
      blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-primary/50 pl-3 text-muted-foreground">{children}</blockquote>,
      code: ({ children }) => <code className="rounded bg-muted px-1 font-mono text-[0.9em]">{children}</code>,
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
      ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
      span: ({ node, children }) => node?.properties['data-spoiler'] || node?.properties['dataSpoiler'] ? <Spoiler>{children}</Spoiler> : <span className="rounded bg-primary/15 px-0.5 font-medium text-primary">{children}</span>,
    }}>{message.body}</Markdown>;
}
