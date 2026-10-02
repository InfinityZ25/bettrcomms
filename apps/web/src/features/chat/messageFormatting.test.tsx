import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '@/api';
import FormattedMessage from './FormattedMessage';
import { formatSelection, safeMessageURL, needsMessageFormatting, formatMessagePreview } from './messageFormatting';

const member = '11111111-1111-4111-8111-111111111111';
function render(body: string) {
  return renderToStaticMarkup(<FormattedMessage message={{ body, mentions: [{ id: member, name: 'Alice' }] } as Message} />);
}

describe('formatted messages', () => {
  it('renders emphasis, block quotes, lists and code without interpreting code as markup', () => {
    const html = render('**bold** *italic* ~~old~~\n\n> quoted\n\n- one\n- two\n\n```js\n<script>danger</script>\n```');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<del>old</del>');
    expect(html).toContain('<blockquote');
    expect(html).toContain('<ul');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('hides spoiler contents from both visible and accessible initial markup', () => {
    const html = render('Before ||secret ending|| after');
    expect(html).toContain('Reveal spoiler');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('secret ending');
    expect(render('||**secret** and `code`||')).not.toContain('secret</strong>');
    expect(render('`||literal||`')).toContain('||literal||');
  });
  it('resolves authorized mentions outside inline and fenced code', () => {
    const html = render(`<@${member}> \`<@${member}>\`\n\n\`\`\`\n<@${member}>\n\`\`\``);
    expect(html.match(/@Alice/g)).toHaveLength(1);
    expect(html).toContain('&lt;@' + member + '&gt;');
  });
  it('does not fetch markdown images or allow script, relative or credential-bearing links', () => {
    const html = render('![remote](https://example.test/tracker.png) [unsafe](javascript:alert%281%29) [relative](/api/v1/me)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href=');
    expect(safeMessageURL('https://user:secret@example.test')).toBe('');
    expect(safeMessageURL('data:text/html,test')).toBe('');
  });
  it('formats only the selection and keeps its cursor range inside delimiters', () => {
    expect(formatSelection('hello world', 6, 11, 'bold')).toEqual({ value: 'hello **world**', start: 8, end: 13 });
    expect(formatSelection('first\nsecond', 0, 12, 'quote').value).toBe('> first\n> second');
  });
  it('keeps URL punctuation on the plain fast path and recognizes markdown links', () => {
    expect(needsMessageFormatting('https://example.test/wiki_(help)')).toBe(false);
    expect(needsMessageFormatting('[help](https://example.test/wiki_(help))')).toBe(true);
    expect(needsMessageFormatting('**hi**')).toBe(true);
    expect(formatMessagePreview('one ||**secret**\nending|| two')).toBe('one [spoiler] two');
    expect(formatMessagePreview('one ||secret truncated')).toBe('one [spoiler]');
  });
});
