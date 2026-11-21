export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(str: string): string {
  return escapeHtml(str);
}

/**
 * Tokenizer-based formatter:
 * 1. Protects fenced code blocks (```...```) and inline code (`...`) before escaping/inline rules.
 * 2. Escapes HTML safely.
 * 3. Renders blockquotes (> ...), safe https?:// links (protected from italic/bold mangling),
 *    **bold**, *italic*, ~~strike~~, and @mentions.
 */
export function formatMessageBody(raw: string, myNickname?: string): string {
  const placeholders: string[] = [];
  const token = (idx: number) => `\uE000TOK${idx}\uE001`;
  const stash = (html: string) => {
    const idx = placeholders.length;
    placeholders.push(html);
    return token(idx);
  };

  let text = String(raw).replace(/[\uE000\uE001]/g, '');

  // 1. Fenced code blocks (multiline)
  text = text.replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g, (_m, _lang, code) =>
    stash(`<pre class="msg-code-block"><code>${escapeHtml(String(code).replace(/\n$/, ''))}</code></pre>`)
  );
  // Single-line fenced fallback ```code```
  text = text.replace(/```([^`\n]+)```/g, (_m, code) =>
    stash(`<pre class="msg-code-block"><code>${escapeHtml(String(code).trim())}</code></pre>`)
  );

  // 2. Inline code
  text = text.replace(/`([^`\n]+)`/g, (_m, code) =>
    stash(`<code class="msg-inline-code">${escapeHtml(String(code))}</code>`)
  );

  // 3. Escape all remaining HTML
  let safe = escapeHtml(text);

  // 4. Protect links before emphasis parsing so URLs with * or _ stay intact
  safe = safe.replace(/\b(https?:\/\/[^\s<>"'`\uE000\uE001]+)/g, (match) => {
    let url = match;
    let suffix = '';
    while (/[.,;:!?)]$/.test(url)) {
      const last = url.slice(-1);
      if (last === ')' && (url.match(/\(/g)?.length || 0) >= (url.match(/\)/g)?.length || 0)) {
        break;
      }
      suffix = last + suffix;
      url = url.slice(0, -1);
    }
    const anchor = `<a href="${url}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${url}</a>`;
    return `${stash(anchor)}${suffix}`;
  });

  // 5. Blockquotes (group consecutive lines starting with "&gt; ")
  const lines = safe.split(/\r?\n/);
  const built: string[] = [];
  let quoteBuf: string[] = [];
  const flushQuote = () => {
    if (quoteBuf.length > 0) {
      built.push(`<blockquote class="msg-blockquote">${quoteBuf.join('\n')}</blockquote>`);
      quoteBuf = [];
    }
  };
  for (const line of lines) {
    if (line.startsWith('&gt; ')) {
      quoteBuf.push(line.slice(5));
    } else if (line === '&gt;') {
      quoteBuf.push('');
    } else {
      flushQuote();
      built.push(line);
    }
  }
  flushQuote();

  safe = '';
  for (let i = 0; i < built.length; i++) {
    const cur = built[i];
    if (i > 0) {
      const prev = built[i - 1];
      const prevIsBlock =
        prev.startsWith('<blockquote') ||
        /^\uE000TOK\d+\uE001$/.test(prev) && placeholders[Number(prev.slice(4, -1))]?.startsWith('<pre');
      const curIsBlock =
        cur.startsWith('<blockquote') ||
        /^\uE000TOK\d+\uE001$/.test(cur) && placeholders[Number(cur.slice(4, -1))]?.startsWith('<pre');
      if (!prevIsBlock && !curIsBlock) {
        safe += '\n';
      }
    }
    safe += cur;
  }

  // 6. Inline emphasis (strong, em, strike)
  safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/(^|[^*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?!\*)/g, '$1<em>$2</em>');
  safe = safe.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 7. Mentions
  const myLower = myNickname ? myNickname.toLowerCase() : '';
  safe = safe.replace(/(^|\s)(@[a-zA-Z0-9_\-\uAC00-\uD7A3]+)/g, (_m, lead, mention) => {
    const isMe = myLower && mention.slice(1).toLowerCase() === myLower;
    return `${lead}<span class="chat-mention${isMe ? ' mention-me' : ''}">${mention}</span>`;
  });

  // 8. Restore placeholders
  safe = safe.replace(/\uE000TOK(\d+)\uE001/g, (_m, idxStr) => placeholders[Number(idxStr)] ?? '');
  return safe;
}
