import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '@/api';
import { MessageBody } from './MessageItem';

function body(value: string) {
  return renderToStaticMarkup(<MessageBody message={{ body: value, mentions: [] } as unknown as Message} />);
}

describe('message links', () => {
  it('links HTTP URLs without including punctuation or allowing an opener', () => {
    const html = body('Read https://example.com/page?x=1, then http://example.org!');
    expect(html).toContain('href="https://example.com/page?x=1"');
    expect(html).toContain('href="http://example.org/"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('</a>, then');
  });

  it('keeps script URLs and markup as escaped text', () => {
    const html = body('javascript:alert(1) <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a');
    expect(html).toContain('&lt;img');
  });

  it('excludes unmatched closing brackets but retains balanced URL brackets', () => {
    const html = body('(https://example.com/help) and https://example.com/wiki_(help)');
    expect(html).toContain('href="https://example.com/help"');
    expect(html).toContain('</a>) and');
    expect(html).toContain('href="https://example.com/wiki_(help)"');
  });
});
