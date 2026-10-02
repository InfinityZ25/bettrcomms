export type FormatKind = 'bold' | 'italic' | 'code' | 'quote' | 'spoiler';

export function needsMessageFormatting(body: string) {
  if (/\[[^\]\n]+\]\(/.test(body)) return true;
  const text = body.replace(/https?:\/\/[^\s<]+/gi, '');
  return /[*_~`|]|(?:^|\n)\s*(?:>|[-+] |\d+\. |#{1,6} )/.test(text);
}

export function formatMessagePreview(body: string) {
  return body.replace(/\|\|[\s\S]*?(?:\|\||$)/g, '[spoiler]').replace(/<@[0-9a-f-]{36}>/gi, '@member');
}

export function formatSelection(value: string, start: number, end: number, kind: FormatKind) {
  const selected = value.slice(start, end) || 'text';
  const markers = { bold: '**', italic: '*', code: '`', spoiler: '||' };
  const marker = kind === 'quote' ? '' : markers[kind];
  const prefix = kind === 'quote' ? (start && value[start - 1] !== '\n' ? '\n' : '') : '';
  const replacement = kind === 'quote'
    ? prefix + selected.split('\n').map((line) => '> ' + line).join('\n')
    : marker + selected + marker;
  return {
    value: value.slice(0, start) + replacement + value.slice(end),
    start: start + (kind === 'quote' ? prefix.length + 2 : marker.length),
    end: start + replacement.length - marker.length,
  };
}

export function safeMessageURL(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
