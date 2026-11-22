import { REACTION_EMOJIS } from '../commands';
import { escapeAttr, escapeHtml, formatMessageBody } from '../markdown';
import { classifyFilePreview, formatFileSize } from '../media';
import { ChatMessage } from '../types';
import {
  REVCHAT_ASCII_BANNER,
  iconCopy,
  iconDownload,
  iconEye,
  iconMic,
  iconPaperclip,
  iconReply,
  iconShare,
  iconSmilePlus,
  iconTrash,
} from './icons';

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

  if (att.kind === 'image' && att.url) {
    const safeUrl = escapeAttr(att.url);
    const pct = Math.max(0, Math.min(100, att.progress ?? 0));
    let extra = '';
    if (att.status === 'sending') {
      extra = `
        <div class="msg-media-progress compact" data-transfer-id="${escapeAttr(att.transferId)}">
          <div class="msg-media-prog-top">
            <span>Sending <b>${safeName}</b> (${sizeLabel})</span>
            <span class="prog-pct">${pct}%</span>
          </div>
          <div class="msg-prog-track"><div class="msg-prog-fill" style="width:${pct}%;"></div></div>
          <button type="button" class="small" data-cancel-transfer="${escapeAttr(att.transferId)}">CANCEL</button>
        </div>
      `;
    } else if (att.status === 'error') {
      extra = `<div class="msg-media-status err">Transfer failed</div>`;
    }
    return `
      <div class="msg-media-box">
        <img
          src="${safeUrl}"
          alt="${safeAttrName}"
          class="msg-media-img"
          data-lightbox-url="${safeUrl}"
          data-lightbox-name="${safeAttrName}"
        />
        ${extra}
      </div>
    `;
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
      </div>
    `;
  }

  const previewKind = classifyFilePreview(att.mimeType, att.name);
  if (previewKind !== 'none') {
    return `
      <div class="msg-file-card previewable" data-preview-id="${escapeAttr(m.id)}">
        <span class="file-tag" aria-label="File attachment">${iconPaperclip(14)}</span>
        <span class="file-meta">
          <b>${safeName}</b>
          <span>${sizeLabel}</span>
        </span>
        <span class="file-card-actions">
          <button type="button" class="small file-action-btn" data-preview-id="${escapeAttr(m.id)}" title="Preview ${safeAttrName}" aria-label="Preview">${iconEye(13)}<span>VIEW</span></button>
          <a class="btn small file-action-btn" href="${safeUrl}" download="${safeAttrName}" title="Download ${safeAttrName}" aria-label="Save">${iconDownload(13)}<span>SAVE</span></a>
        </span>
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

function renderGameCardHtml(icon: string, tag: string, val: string, sub?: string): string {
  return `
    <div class="msg-game-card">
      <span class="game-res-icon" aria-hidden="true">${icon}</span>
      <span class="game-res-tag">${escapeHtml(tag)}</span>
      <span class="game-res-sep" aria-hidden="true"></span>
      <span class="game-res-content">
        <span class="game-res-val">${escapeHtml(val)}</span>
        ${sub ? `<span class="game-res-sub">${escapeHtml(sub)}</span>` : ''}
      </span>
    </div>
  `;
}

function renderGameResultHtml(text: string): string | null {
  let m = text.match(/^🪙 COIN · (HEADS|TAILS)$/);
  if (m) return renderGameCardHtml('🪙', 'COIN', m[1]);

  m = text.match(/^🎲 DICE (d\d+) · (\d+)$/);
  if (m) return renderGameCardHtml('🎲', m[1], m[2]);

  m = text.match(/^🎲 RPS · (✊|✋|✌️) (ROCK|PAPER|SCISSORS)$/);
  if (m) return renderGameCardHtml(m[1], 'RPS', m[2], 'RANDOM');

  m = text.match(/^(✊|✋|✌️) RPS · (ROCK|PAPER|SCISSORS)$/);
  if (m) return renderGameCardHtml(m[1], 'RPS', m[2]);

  m = text.match(/^🎯 PICK · (.+) \((.+)\)$/);
  if (m) return renderGameCardHtml('🎯', 'PICK', m[1], `from ${m[2]}`);

  m = text.match(/^🎱 8-BALL · (.+) → (.+)$/);
  if (m) return renderGameCardHtml('🎱', '8-BALL', m[2], m[1]);

  return null;
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
        <button type="button" class="msg-action-link" data-react-open="${escapeAttr(m.id)}" title="React" aria-label="React">${iconSmilePlus(14)}</button>
        ${
          m.text
            ? `<button type="button" class="msg-action-link" data-copy-id="${escapeAttr(m.id)}" title="Copy" aria-label="Copy">${iconCopy(14)}</button>`
            : ''
        }
        <button
          type="button"
          class="msg-action-link"
          data-reply-id="${escapeAttr(m.id)}"
          data-reply-sender="${escapeAttr(m.senderName)}"
          data-reply-text="${escapeAttr((m.text || m.attachment?.name || 'attachment').slice(0, 80))}"
          title="Reply"
          aria-label="Reply"
        >${iconReply(14)}</button>
        ${
          isSelf
            ? `<button type="button" class="msg-action-link danger-link" data-delete-id="${escapeAttr(m.id)}" title="Delete" aria-label="Delete">${iconTrash(14)}</button>`
            : ''
        }
      </span>
    `;

  const bodyContent = m.deleted
    ? `<div class="msg-deleted">Message deleted</div>`
    : `
      ${renderAttachmentHtml(m)}
      ${
        m.text
          ? (renderGameResultHtml(m.text) ??
            `<div class="msg-body">${formatMessageBody(m.text, ctx.myNickname)}</div>`)
          : ''
      }
    `;

  return `
    <div class="msg-row ${isSelf ? 'self' : ''} ${m.targetPeerId ? 'whisper' : ''} ${grouped ? 'grouped' : ''}" data-msg-id="${escapeAttr(m.id)}">
      ${
        grouped
          ? ''
          : `<div class="msg-header">
        <span class="msg-author ${isSelf ? 'self' : ''}">${escapeHtml(m.senderName)}</span>
        <span class="msg-time">${timeStr}</span>
      </div>`
      }
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
      ${
        actionButtons
          ? `<div class="msg-toolbar">${grouped ? `<span class="msg-time">${timeStr}</span>` : ''}${actionButtons}</div>`
          : ''
      }
      ${bodyContent}
      ${statusHtml ? `<div class="msg-status">${statusHtml}</div>` : ''}
      ${!m.deleted ? renderReactionsHtml(m, ctx.myPeerId) : ''}
      <div class="reaction-picker-slot" data-react-slot="${escapeAttr(m.id)}"></div>
    </div>
  `;
}

export function renderEmptyStateHtml(ctx: MessageRenderContext): string {
  const isLobby = ctx.roomId === 'LOBBY';
  return `
    <div class="empty-state">
      <pre class="ascii-banner">
${REVCHAT_ASCII_BANNER}</pre>
      <div class="empty-header">#${escapeHtml(ctx.roomId)}</div>
      <div class="empty-actions">
        <button type="button" class="small primary" id="btn-empty-invite">${iconShare(14)}<span>INVITE</span></button>
        ${isLobby ? `<button type="button" class="small" id="btn-empty-new-room">NEW ROOM</button>` : ''}
      </div>
      <div class="empty-hint">
        ${
          isLobby
            ? 'Public lobby — share the invite link or create a private room. Messages are sent live to online peers only and never saved.'
            : 'Share the invite link or room code to start talking. Messages are sent live to online peers only and never saved.'
        }
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
