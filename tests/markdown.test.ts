import { describe, expect, it } from 'vitest';
import { escapeHtml, formatMessageBody } from '../src/markdown';

describe('markdown module', () => {
  it('escapes HTML tags safely', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('protects inline code asterisks from becoming italics', () => {
    const html = formatMessageBody('Check `a * b * c` and *real italic*');
    expect(html).toContain('<code class="msg-inline-code">a * b * c</code>');
    expect(html).toContain('<em>real italic</em>');
  });

  it('keeps multiplication asterisks literal without turning them into italics', () => {
    const html = formatMessageBody('2 * 3 * 4 and *real italic*');
    expect(html).toContain('2 * 3 * 4');
    expect(html).toContain('<em>real italic</em>');
  });

  it('protects fenced code blocks from bold/link conversion and HTML injection', () => {
    const html = formatMessageBody('```js\nconst x = "**not bold** <img onerror=1>";\n```');
    expect(html).toContain('<pre class="msg-code-block"><code>');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('&lt;img onerror=1&gt;');
  });

  it('preserves URLs containing underscores or asterisks', () => {
    const html = formatMessageBody('See https://example.com/a_b*c and **bold**');
    expect(html).toContain('href="https://example.com/a_b*c"');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<em>');
  });

  it('renders blockquotes, strikethrough, and highlights own @mention', () => {
    const html = formatMessageBody('> quoted line\n~~old~~ hello @Alice and @Bob', 'Alice');
    expect(html).toContain('<blockquote class="msg-blockquote">quoted line</blockquote>');
    expect(html).toContain('<del>old</del>');
    expect(html).toContain('<span class="chat-mention mention-me">@Alice</span>');
    expect(html).toContain('<span class="chat-mention">@Bob</span>');
  });
});
