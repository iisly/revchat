import { escapeAttr, escapeHtml } from '../markdown';
import { copyTextToClipboard } from '../storage';
import { REVCHAT_ASCII_BANNER, iconClose, iconDownload } from './icons';

export type ActiveModalType = 'none' | 'invite' | 'help' | 'lightbox';

export interface ModalContext {
  activeModal: ActiveModalType;
  roomId: string;
  inviteUrl: string;
  inviteQrSvg: string;
  lightboxUrl?: string;
  lightboxName?: string;
}

export interface ModalCallbacks {
  onClose: () => void;
  onToast: (msg: string) => void;
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
            <button type="button" class="small icon-btn" id="btn-modal-close" title="Close" aria-label="Close">${iconClose(14)}</button>
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
              <a class="btn small" href="${safeUrl}" download="${escapeAttr(ctx.lightboxName || 'image')}" title="Save ${escapeAttr(ctx.lightboxName || 'image')}">${iconDownload(13)}<span>SAVE</span></a>
              <button type="button" class="small icon-btn" id="btn-modal-close" title="Close" aria-label="Close">${iconClose(14)}</button>
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

  // Help Modal
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal help-modal" role="dialog" aria-modal="true" aria-label="Guide & Commands">
        <div class="modal-header">
          <span class="modal-brand-title"><img src="./favicon.svg" class="brand-logo" width="18" height="18" alt="" /><span>Guide & Commands</span></span>
          <button type="button" class="small icon-btn" id="btn-modal-close" title="Close" aria-label="Close">${iconClose(14)}</button>
        </div>
        <div class="modal-body help-modal-body">
          <pre class="ascii-banner">
${REVCHAT_ASCII_BANNER}</pre>

          <div class="help-section">
            <div class="help-section-title">How to Chat</div>
            <div class="help-guide-card">
              <div class="help-guide-lead">
                <b>Direct P2P chat — no accounts, no servers, no logs.</b>
              </div>
              <div class="help-guide-steps">
                <div class="help-step-item">
                  <span class="help-step-num">1</span>
                  <div class="help-step-content">
                    <b>Join the Same Room</b>
                    <span>Share the invite link/QR at the top right, or enter the same room code.</span>
                  </div>
                </div>
                <div class="help-step-item">
                  <span class="help-step-num">2</span>
                  <div class="help-step-content">
                    <b>Media, Voice, Calls &amp; Games</b>
                    <span>Tap <code>+</code> for Calls, Voice, Files, and Games, or <code>☺</code> for emotes. Paste or drop files to preview before sending.</span>
                  </div>
                </div>
                <div class="help-step-item">
                  <span class="help-step-num">3</span>
                  <div class="help-step-content">
                    <b>Actions &amp; Shortcuts</b>
                    <span>Hover a message (tap on mobile) to react, copy, reply, or delete. Press <code>/</code> to focus chat.</span>
                  </div>
                </div>
              </div>
              <div class="help-guide-footer">
                Close the browser tab to wipe everything.
              </div>
            </div>
          </div>

          <div class="help-section">
            <div class="help-section-title">Formatting (Markdown)</div>
            <div class="help-group">
              <div class="help-cmd-row"><code>**bold**</code><span>Bold</span></div>
              <div class="help-cmd-row"><code>*italic*</code><span>Italic</span></div>
              <div class="help-cmd-row"><code>~~strike~~</code><span>Strikethrough</span></div>
              <div class="help-cmd-row"><code>\`code\`</code><span>Inline code</span></div>
              <div class="help-cmd-row"><code>\`\`\`block\`\`\`</code><span>Code block</span></div>
              <div class="help-cmd-row"><code>&gt; quote</code><span>Blockquote</span></div>
              <div class="help-cmd-row"><code>@name / @me</code><span>Mention</span></div>
              <div class="help-cmd-row"><code>https://...</code><span>Auto link</span></div>
            </div>
          </div>

          <div class="help-section">
            <div class="help-section-title">Commands</div>
            <div class="help-group">
              <div class="help-cmd-row"><code>/nick &lt;name&gt;</code><span>Set nickname</span></div>
              <div class="help-cmd-row"><code>/room [code]</code><span>Switch / random room</span></div>
              <div class="help-cmd-row"><code>/clear</code><span>Clear chat</span></div>
              <div class="help-cmd-row"><code>/size &lt;12-22|+|-|reset&gt;</code><span>Text size</span></div>
              <div class="help-cmd-row"><code>/theme [dark|light]</code><span>Switch theme</span></div>
              <div class="help-cmd-row"><code>/mute</code><span>Toggle sound</span></div>
              <div class="help-cmd-row"><code>/help</code><span>Open guide</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  bindBaseClose();
}
