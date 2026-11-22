import { escapeAttr, escapeHtml } from '../markdown';
import {
  MAX_CSV_PREVIEW_ROWS,
  MAX_TEXT_PREVIEW_BYTES,
  formatFileSize,
  parseDelimitedTable,
} from '../media';
import { copyTextToClipboard } from '../storage';
import { REVCHAT_ASCII_BANNER, iconClose, iconCopy, iconDownload } from './icons';

export type ActiveModalType = 'none' | 'invite' | 'help' | 'lightbox' | 'file-preview';

export interface FilePreviewState {
  kind: 'text' | 'csv' | 'pdf';
  name: string;
  url: string;
  sizeLabel: string;
  text?: string;
  truncated?: boolean;
  csvViewMode?: 'table' | 'raw';
  delimiter?: ',' | '\t';
  error?: string;
}

export interface ModalContext {
  activeModal: ActiveModalType;
  roomId: string;
  inviteUrl: string;
  inviteQrSvg: string;
  lightboxUrl?: string;
  lightboxName?: string;
  filePreview?: FilePreviewState;
}

export interface ModalCallbacks {
  onClose: () => void;
  onToast: (msg: string) => void;
  onToggleCsvMode?: () => void;
}

export function renderModalDOM(
  modalRoot: HTMLElement | null,
  ctx: ModalContext,
  callbacks: ModalCallbacks
): void {
  if (!modalRoot) return;
  if (ctx.activeModal === 'none') {
    modalRoot.innerHTML = '';
    return;
  }

  const bindBaseClose = () => {
    modalRoot.querySelector('#btn-modal-close')?.addEventListener('click', callbacks.onClose);
    modalRoot.querySelector('#modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) callbacks.onClose();
    });
  };

  if (ctx.activeModal === 'invite') {
    const canNativeShare = typeof navigator.share === 'function';
    modalRoot.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Invite to room">
          <div class="modal-header">
            <span>INVITE TO #${escapeHtml(ctx.roomId)}</span>
            <button type="button" class="small icon-btn" id="btn-modal-close" aria-label="Close">${iconClose(14)}</button>
          </div>
          <div class="modal-body">
            <div class="qr-box">${ctx.inviteQrSvg}</div>
            <div class="modal-caption">
              Scan with mobile camera to join <b>#${escapeHtml(ctx.roomId)}</b> immediately
            </div>
            <div class="step-block">
              <div class="step-title">Shareable Invite Link</div>
              <div class="field-row">
                <input type="text" readonly value="${escapeAttr(ctx.inviteUrl)}" id="invite-url-input" />
                <button type="button" class="primary" id="btn-copy-invite">COPY</button>
                ${canNativeShare ? `<button type="button" id="btn-native-share">SHARE</button>` : ''}
              </div>
            </div>
            <div class="step-block">
              <div class="step-title">Room Code</div>
              <div class="kv-line">
                <span>Room Code:</span>
                <code class="code-pill">${escapeHtml(ctx.roomId)}</code>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    bindBaseClose();
    modalRoot.querySelector('#btn-copy-invite')?.addEventListener('click', () => {
      void copyTextToClipboard(ctx.inviteUrl).then((ok) =>
        callbacks.onToast(ok ? 'Invite URL copied to clipboard' : 'Could not copy invite URL')
      );
    });
    modalRoot.querySelector('#btn-native-share')?.addEventListener('click', () => {
      navigator
        .share({
          title: `Join #${ctx.roomId} on revchat`,
          text: `Join my P2P chat room #${ctx.roomId}`,
          url: ctx.inviteUrl,
        })
        .catch(() => {});
    });
    return;
  }

  if (ctx.activeModal === 'lightbox') {
    const safeUrl = escapeAttr(ctx.lightboxUrl || '');
    const safeName = escapeHtml(ctx.lightboxName || 'image');
    modalRoot.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop">
        <div class="modal lightbox-modal" role="dialog" aria-modal="true" aria-label="Image Preview">
          <div class="modal-header">
            <span>${safeName}</span>
            <div class="tool-group">
              <a class="btn small" href="${safeUrl}" download="${escapeAttr(ctx.lightboxName || 'image')}">${iconDownload(13)}<span>SAVE</span></a>
              <button type="button" class="small icon-btn" id="btn-modal-close" aria-label="Close">${iconClose(14)}</button>
            </div>
          </div>
          <div class="lightbox-body">
            <img src="${safeUrl}" alt="${escapeAttr(ctx.lightboxName || 'image')}" />
          </div>
        </div>
      </div>
    `;
    bindBaseClose();
    return;
  }

  if (ctx.activeModal === 'file-preview' && ctx.filePreview) {
    const p = ctx.filePreview;
    const safeUrl = p.url.startsWith('blob:') ? escapeAttr(p.url) : '';
    const safeName = escapeHtml(p.name);
    const safeAttrName = escapeAttr(p.name);

    let bodyHtml = '';
    if (p.error) {
      bodyHtml = `<div class="preview-error-box">${escapeHtml(p.error)}</div>`;
    } else if (p.kind === 'pdf') {
      if (!safeUrl) {
        bodyHtml = `<div class="preview-error-box">Could not preview PDF file.</div>`;
      } else {
        bodyHtml = `
          <iframe class="preview-pdf-frame" src="${safeUrl}" title="${safeAttrName}"></iframe>
          <div class="preview-pdf-hint">If the PDF does not render inline on mobile, tap <b>OPEN</b> or <b>SAVE</b> above.</div>
        `;
      }
    } else if (p.kind === 'csv' && p.csvViewMode !== 'raw') {
      const parsed = parseDelimitedTable(p.text || '', p.delimiter || ',');
      if (parsed.rows.length === 0) {
        bodyHtml = `<div class="preview-error-box">Empty table file.</div>`;
      } else {
        const colCount = Math.max(1, ...parsed.rows.map((r) => r.length));
        const renderRow = (row: string[], tag: 'th' | 'td') =>
          Array.from(
            { length: colCount },
            (_, idx) => `<${tag}>${escapeHtml(row[idx] ?? '')}</${tag}>`
          ).join('');
        const noticeHtml =
          p.truncated || parsed.truncated
            ? `<div class="preview-notice">Preview limited to first ${MAX_CSV_PREVIEW_ROWS} rows / ${formatFileSize(MAX_TEXT_PREVIEW_BYTES)}. Use SAVE for the full file.</div>`
            : '';
        bodyHtml = `
          ${noticeHtml}
          <div class="preview-table-wrap">
            <table class="preview-csv-table">
              <thead><tr>${renderRow(parsed.rows[0], 'th')}</tr></thead>
              <tbody>${parsed.rows
                .slice(1)
                .map((row) => `<tr>${renderRow(row, 'td')}</tr>`)
                .join('')}</tbody>
            </table>
          </div>
        `;
      }
    } else {
      const noticeHtml = p.truncated
        ? `<div class="preview-notice">Preview limited to first ${formatFileSize(MAX_TEXT_PREVIEW_BYTES)}. Use SAVE for the full file.</div>`
        : '';
      bodyHtml = `
        ${noticeHtml}
        <pre class="preview-code-pre"><code>${escapeHtml(p.text || '')}</code></pre>
      `;
    }

    modalRoot.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop">
        <div class="modal file-preview-modal" role="dialog" aria-modal="true" aria-label="File Preview">
          <div class="modal-header">
            <span class="modal-title-ellipsis" title="${safeAttrName}">${safeName} <small class="modal-size-tag">${escapeHtml(p.sizeLabel)}</small></span>
            <div class="tool-group">
              ${
                p.kind === 'csv' && !p.error
                  ? `<button type="button" class="small" id="btn-preview-csv-toggle">${p.csvViewMode === 'raw' ? 'TABLE' : 'RAW'}</button>`
                  : ''
              }
              ${
                (p.kind === 'text' || p.kind === 'csv') && p.text !== undefined && !p.error
                  ? `<button type="button" class="small" id="btn-preview-copy">${iconCopy(13)}<span>COPY</span></button>`
                  : ''
              }
              ${
                p.kind === 'pdf' && safeUrl
                  ? `<a class="btn small" href="${safeUrl}" target="_blank" rel="noopener noreferrer">OPEN</a>`
                  : ''
              }
              ${
                safeUrl
                  ? `<a class="btn small" href="${safeUrl}" download="${safeAttrName}">${iconDownload(13)}<span>SAVE</span></a>`
                  : ''
              }
              <button type="button" class="small icon-btn" id="btn-modal-close" aria-label="Close">${iconClose(14)}</button>
            </div>
          </div>
          <div class="file-preview-body">
            ${bodyHtml}
          </div>
        </div>
      </div>
    `;
    modalRoot.querySelector('#btn-preview-copy')?.addEventListener('click', () => {
      void copyTextToClipboard(p.text || '').then((ok) =>
        callbacks.onToast(ok ? 'File contents copied to clipboard' : 'Could not copy file contents')
      );
    });
    modalRoot.querySelector('#btn-preview-csv-toggle')?.addEventListener('click', () => {
      callbacks.onToggleCsvMode?.();
    });
    bindBaseClose();
    return;
  }

  // Help Modal
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal help-modal" role="dialog" aria-modal="true" aria-label="Guide and Commands">
        <div class="modal-header">
          <span class="modal-brand-title"><img src="./favicon.svg" class="brand-logo" width="18" height="18" alt="" /><span>Guide & Commands</span></span>
          <button type="button" class="small icon-btn" id="btn-modal-close" aria-label="Close">${iconClose(14)}</button>
        </div>
        <div class="modal-body help-modal-body">
          <pre class="ascii-banner">
${REVCHAT_ASCII_BANNER}</pre>

          <div class="help-section">
            <div class="help-section-title">How to Chat</div>
            <div class="help-guide-card">
              <div class="help-guide-lead">
                <b>You must be in the same room to talk.</b>
                <span class="help-guide-sub">No accounts, no hosts, no servers. Direct device-to-device connections.</span>
              </div>
              <div class="help-guide-steps">
                <div class="help-step-item">
                  <span class="help-step-num">1</span>
                  <div class="help-step-content">
                    <b>Share Invite Link</b>
                    <span>Tap the invite icon at the top right for a QR code or link. Anyone who opens it joins your room immediately.</span>
                  </div>
                </div>
                <div class="help-step-item">
                  <span class="help-step-num">2</span>
                  <div class="help-step-content">
                    <b>Or Use the Same Room Code</b>
                    <span>Tell your friends a room name. Anyone entering the same room connects automatically.</span>
                  </div>
                </div>
                <div class="help-step-item">
                  <span class="help-step-num">3</span>
                  <div class="help-step-content">
                    <b>Calls, Voice, Files & Games via [+]</b>
                    <span>Tap <code>+</code> beside the message box for Calls, Voice notes, Files/Media, and Games, or <code>☺</code> for ASCII emotes.</span>
                  </div>
                </div>
                <div class="help-step-item">
                  <span class="help-step-num">4</span>
                  <div class="help-step-content">
                    <b>Message Actions &amp; Shortcuts</b>
                    <span>Hover a message (or tap on mobile) to react, copy, reply, or delete. Press <code>/</code> anywhere to focus the chat box.</span>
                  </div>
                </div>
              </div>
              <div class="help-guide-footer">
                No database, zero logs. Close the browser tab to wipe everything.
              </div>
            </div>
          </div>

          <div class="help-section">
            <div class="help-section-title">Formatting (Markdown)</div>
            <div class="help-group">
              <div class="help-cmd-row"><code>**bold** / *italic* / ~~strike~~</code><span>Inline text formatting</span></div>
              <div class="help-cmd-row"><code>\`code\` / \`\`\`block\`\`\`</code><span>Inline and multi-line code</span></div>
              <div class="help-cmd-row"><code>&gt; quote</code><span>Blockquote</span></div>
              <div class="help-cmd-row"><code>@name / @me</code><span>Mention a peer or expand your nickname</span></div>
            </div>
          </div>

          <div class="help-section">
            <div class="help-section-title">Commands</div>
            <div class="help-group">
              <div class="help-cmd-row"><code>/nick &lt;name&gt;</code><span>Change your display nickname</span></div>
              <div class="help-cmd-row"><code>/room [code]</code><span>Switch room (or join a new random room if omitted)</span></div>
              <div class="help-cmd-row"><code>/clear</code><span>Clear local chat view</span></div>
              <div class="help-cmd-row"><code>/size &lt;12-22|+|-|reset&gt;</code><span>Change chat text size</span></div>
              <div class="help-cmd-row"><code>/theme [dark|light]</code><span>Switch dark/light theme</span></div>
              <div class="help-cmd-row"><code>/mute</code><span>Toggle notification sound</span></div>
              <div class="help-cmd-row"><code>/help</code><span>Open this guide</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  bindBaseClose();
}
