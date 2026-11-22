import { REACTION_EMOJIS } from '../commands';
import { escapeAttr, escapeHtml, formatMessageBody } from '../markdown';
import { formatDuration, formatFileSize } from '../media';
import { ChatMessage } from '../types';
import { REVCHAT_ASCII_BANNER, iconDownload, iconMic, iconPaperclip, iconShare } from './icons';

const GROUP_WINDOW_MS = 180_000;

export interface MessageRenderContext {
  myPeerId: string;
  myNickname: string;
  myClientId: string;
  roomId: string;
  searchQuery: string;
}

export function isMessageFromSelf(m: ChatMessage, ctx: MessageRenderContext): boolean {
  return (
    m.senderId === ctx.myPeerId ||
    m.senderId.startsWith(`revchat-p-${ctx.myClientId.toLowerCase()}`)
  );
}

export function shouldGroupMessages(prev: ChatMessage | undefined, cur: ChatMessage): boolean {
  if (!prev) return false;
  if (prev.system || cur.system) return false;
  if (prev.deleted || cur.deleted) return false;
  if (prev.targetPeerId || cur.targetPeerId) return false;
  if (cur.replyTo) return false;
  if (prev.senderId !== cur.senderId) return false;
  return cur.timestamp - prev.timestamp >= 0 && cur.timestamp - prev.timestamp < GROUP_WINDOW_MS;
}

function renderAttachmentHtml(m: ChatMessage): string {
  const att = m.attachment;
  if (!att) return '';

  const safeName = escapeHtml(att.name);
  const safeAttrName = escapeAttr(att.name);
  const sizeLabel = formatFileSize(att.size);

  if (att.status === 'canceled') {
    return `<div class="msg-media-status muted">Transfer canceled: ${safeName}</div>`;
  }
  if (att.status === 'error') {
    return `<div class="msg-media-status err">Transfer failed: ${safeName}</div>`;
  }

  if (att.status === 'sending' || att.status === 'receiving') {
    const pct = Math.max(0, Math.min(100, att.progress ?? 0));
    const label = att.status === 'sending' ? 'Sending' : 'Receiving';
    return `
      <div class="msg-media-progress" data-transfer-id="${escapeAttr(att.transferId)}">
        <div class="msg-media-prog-top">
          <span>${label} <b>${safeName}</b> (${sizeLabel})</span>
          <span class="prog-pct">${pct}%</span>
        </div>
        <div class="msg-prog-track"><div class="msg-prog-fill" style="width:${pct}%;"></div></div>
        <button type="button" class="small" data-cancel-transfer="${escapeAttr(att.transferId)}">CANCEL</button>
      </div>
    `;
  }

  if (!att.url) return '';
  const safeUrl = escapeAttr(att.url);

  if (att.kind === 'image') {
    return `
      <div class="msg-media-box">
        <img
          src="${safeUrl}"
          alt="${safeAttrName}"
          class="msg-media-img"
          data-lightbox-url="${safeUrl}"
          data-lightbox-name="${safeAttrName}"
          loading="lazy"
        />
      </div>
    `;
  }

  if (att.kind === 'video') {
    return `
      <div class="msg-media-box">
        <video src="${safeUrl}" class="msg-media-video" controls playsinline preload="metadata"></video>
        <div class="msg-media-caption">${safeName} • ${sizeLabel}</div>
      </div>
    `;
  }

  if (att.kind === 'audio') {
    return `
      <div class="msg-voice-card">
        <span class="voice-tag" aria-label="Voice message">${iconMic(14)}</span>
        <audio src="${safeUrl}" controls preload="metadata"></audio>
        ${att.durationSec ? `<span class="voice-dur">${formatDuration(att.durationSec)}</span>` : ''}
      </div>
    `;
  }

  return `
    <a class="msg-file-card" href="${safeUrl}" download="${safeAttrName}">
      <span class="file-tag" aria-label="File attachment">${iconPaperclip(14)}</span>
      <span class="file-meta">
        <b>${safeName}</b>
        <span>${sizeLabel}</span>
      </span>
      <span class="file-dl-btn">${iconDownload(13)}<span>SAVE</span></span>
    </a>
  `;
}

function renderReactionsHtml(m: ChatMessage, myPeerId: string): string {
  const entries = m.reactions ? Object.entries(m.reactions).filter(([, list]) => list.length > 0) : [];
  if (entries.length === 0) return '';

  const pills = entries
    .map(([emoji, actors]) => {
      const mine = actors.includes(myPeerId);
      return `<button
        type="button"
        class="reaction-pill ${mine ? 'mine' : ''}"
        data-react-id="${escapeAttr(m.id)}"
        data-react-emoji="${escapeAttr(emoji)}"
      >${escapeHtml(emoji)} ${actors.length}</button>`;
    })
    .join('');

  return `<div class="msg-reactions">${pills}</div>`;
}

export function renderSingleMessageHtml(
  m: ChatMessage,
  ctx: MessageRenderContext,
  grouped = false
): string {
  const timeStr = new Date(m.timestamp).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  if (m.system) {
    return `
      <div class="msg-row system">
        <span class="sys-time">${timeStr}</span>
        <span class="sys-text">${escapeHtml(m.text)}</span>
      </div>
    `;
  }

  const isSelf = isMessageFromSelf(m, ctx);

  let statusHtml = '';
  if (isSelf && !m.deleted) {
    if (m.deliveryState === 'failed') {
      statusHtml = `<button type="button" class="msg-action-link msg-retry-btn" data-retry-id="${escapeAttr(m.id)}" title="No peer acknowledged delivery. Click to retry.">RETRY</button>`;
    } else if (m.ackedBy.length > 0) {
      statusHtml = `<span class="msg-ack" data-ack-id="${escapeAttr(m.id)}">✓✓ ${m.ackedBy.length}</span>`;
    } else {
      statusHtml = `<span class="msg-ack" data-ack-id="${escapeAttr(m.id)}">✓</span>`;
    }
  }

  const actionButtons = m.deleted
    ? ''
    : `
      <span class="msg-actions">
        <button type="button" class="msg-action-link" data-react-open="${escapeAttr(m.id)}" title="React">+</button>
        ${
          m.text
            ? `<button type="button" class="msg-action-link" data-copy-id="${escapeAttr(m.id)}" title="Copy">copy</button>`
            : ''
        }
        <button
          type="button"
          class="msg-action-link"
          data-reply-id="${escapeAttr(m.id)}"
          data-reply-sender="${escapeAttr(m.senderName)}"
          data-reply-text="${escapeAttr((m.text || m.attachment?.name || 'attachment').slice(0, 80))}"
          title="Reply"
        >reply</button>
        ${
          isSelf
            ? `<button type="button" class="msg-action-link danger-link" data-delete-id="${escapeAttr(m.id)}" title="Delete">del</button>`
            : ''
        }
      </span>
    `;

  const bodyContent = m.deleted
    ? `<div class="msg-deleted">Message deleted</div>`
    : `
      ${renderAttachmentHtml(m)}
      ${m.text ? `<div class="msg-body">${formatMessageBody(m.text, ctx.myNickname)}</div>` : ''}
    `;

  if (grouped) {
    return `
      <div class="msg-row ${isSelf ? 'self' : ''} ${m.targetPeerId ? 'whisper' : ''} grouped" data-msg-id="${escapeAttr(m.id)}">
        <div class="msg-grouped-meta">
          <span class="msg-time grouped-time">${timeStr}</span>
          ${actionButtons}
        </div>
        ${bodyContent}
        ${statusHtml ? `<div class="msg-grouped-status">${statusHtml}</div>` : ''}
        ${!m.deleted ? renderReactionsHtml(m, ctx.myPeerId) : ''}
        <div class="reaction-picker-slot" data-react-slot="${escapeAttr(m.id)}"></div>
      </div>
    `;
  }

  return `
    <div class="msg-row ${isSelf ? 'self' : ''} ${m.targetPeerId ? 'whisper' : ''}" data-msg-id="${escapeAttr(m.id)}">
      <div class="msg-header">
        <div class="msg-header-left">
          <span class="msg-author ${isSelf ? 'self' : ''}">${escapeHtml(m.senderName)}</span>
          <span class="msg-time">${timeStr}</span>
        </div>
        <div class="msg-meta-right">${statusHtml}${actionButtons}</div>
      </div>
      ${
        m.targetPeerId
          ? `<div class="msg-whisper-line">DM → ${escapeHtml(m.targetPeerName || 'peer')}</div>`
          : ''
      }
      ${
        m.replyTo
          ? `<div class="msg-quote">@${escapeHtml(m.replyTo.senderName)}: ${escapeHtml(m.replyTo.text)}</div>`
          : ''
      }
      ${bodyContent}
      ${!m.deleted ? renderReactionsHtml(m, ctx.myPeerId) : ''}
      <div class="reaction-picker-slot" data-react-slot="${escapeAttr(m.id)}"></div>
    </div>
  `;
}

export function renderEmptyStateHtml(ctx: MessageRenderContext): string {
  return `
    <div class="empty-state">
      <pre class="ascii-banner">
${REVCHAT_ASCII_BANNER}</pre>
      <div class="empty-header">#${escapeHtml(ctx.roomId)}</div>
      <div class="empty-actions">
        <button type="button" class="small primary" id="btn-empty-invite">${iconShare(14)}<span>INVITE</span></button>
      </div>
      <div class="empty-hint">
        Share the invite link or enter the same room code to start talking. Type <code>/help</code> anytime.
      </div>
    </div>
  `;
}

export function renderMessagesListHtml(
  messages: ChatMessage[],
  ctx: MessageRenderContext
): string {
  const q = ctx.searchQuery.trim().toLowerCase();
  const filtered = q
    ? messages.filter(
        (m) =>
          m.text.toLowerCase().includes(q) ||
          m.senderName.toLowerCase().includes(q) ||
          (m.attachment?.name || '').toLowerCase().includes(q)
      )
    : messages;

  if (filtered.length === 0) {
    if (q) {
      return `<div class="empty-state"><div class="empty-hint">No messages matching "${escapeHtml(ctx.searchQuery)}"</div></div>`;
    }
    return renderEmptyStateHtml(ctx);
  }

  return filtered
    .map((m, idx) => renderSingleMessageHtml(m, ctx, shouldGroupMessages(filtered[idx - 1], m)))
    .join('');
}

export function renderReactionPickerHtml(messageId: string): string {
  return `
    <div class="reaction-picker">
      ${REACTION_EMOJIS.map(
        (emoji) => `
        <button
          type="button"
          class="reaction-opt"
          data-react-id="${escapeAttr(messageId)}"
          data-react-emoji="${escapeAttr(emoji)}"
        >${emoji}</button>
      `
      ).join('')}
    </div>
  `;
}
