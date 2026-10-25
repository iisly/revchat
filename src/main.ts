import { P2PEngine } from './p2p-engine';
import { generateQrSvg } from './qrcode';
import {
  generateRoomCode,
  generateUUID,
  loadUserProfile,
  normalizeRoomId,
  saveUserProfile,
} from './storage';
import { ChatMessage, PeerInfo, SignalingState, UserProfile } from './types';

class RevChatApp {
  private root: HTMLElement;
  private profile: UserProfile;
  private roomId: string;
  private engine!: P2PEngine;

  private signalingState: SignalingState;
  private peers: PeerInfo[] = [];
  private messages: ChatMessage[] = [];
  private messageIds = new Set<string>();
  private typingPeers: { peerId: string; nickname: string }[] = [];

  // UI state
  private mobileDrawerOpen = false;
  private activeModal: 'none' | 'invite' | 'help' = 'none';
  private inviteQrSvg = '';
  private searchOpen = false;
  private searchQuery = '';
  private replyTo: ChatMessage['replyTo'] | undefined = undefined;
  private whisperTarget: { peerId: string; nickname: string } | undefined = undefined;
  private isAtBottom = true;
  private unreadWhileScrolled = 0;

  // Typing debounce
  private lastTypingSentAt = 0;
  private stopTypingTimer: number | null = null;
  private toastTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.profile = loadUserProfile();
    this.applyTheme();

    const initialRoom = this.parseRoomFromUrl() || 'LOBBY';
    this.roomId = normalizeRoomId(initialRoom);
    this.syncUrlWithRoom(this.roomId);

    this.signalingState = {
      status: 'initializing',
      myPeerId: `revchat-p-${this.profile.clientId}`,
      roomId: this.roomId,
      isBeaconHost: false,
    };

    this.setupVisualViewportFix();
    this.render();
    this.initEngine();
  }

  private parseRoomFromUrl(): string | null {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('room');
    if (fromQuery) return normalizeRoomId(fromQuery);

    if (window.location.hash.startsWith('#room=')) {
      return normalizeRoomId(decodeURIComponent(window.location.hash.slice(6)));
    }
    return null;
  }

  private syncUrlWithRoom(roomId: string): void {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('room', roomId);
      window.history.replaceState({}, '', url.toString());
    } catch {
      // ignore
    }
  }

  private getInviteUrl(): string {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('room', this.roomId);
      url.searchParams.set('peer', this.engine ? this.engine.getMyPeerId() : '');
      return url.toString();
    } catch {
      return window.location.href;
    }
  }

  private setupVisualViewportFix(): void {
    const updateHeight = () => {
      const vv = window.visualViewport;
      const h = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${h}px`);
      if (this.isAtBottom) {
        this.scrollToBottom();
      }
    };
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateHeight);
      window.visualViewport.addEventListener('scroll', updateHeight);
    }
    window.addEventListener('resize', updateHeight);
    updateHeight();
  }

  private applyTheme(): void {
    let effective = this.profile.theme;
    if (effective === 'auto') {
      effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', effective);
  }

  private initEngine(): void {
    this.engine = new P2PEngine(this.profile, this.roomId, {
      onSignalingChange: (state) => {
        const prevStatus = this.signalingState.status;
        this.signalingState = state;
        if (prevStatus !== 'ready' && state.status === 'ready') {
          const params = new URLSearchParams(window.location.search);
          const peerToDial = params.get('peer');
          if (peerToDial && peerToDial !== state.myPeerId) {
            this.engine.connectToDirectPeer(peerToDial);
          }
        }
        this.updateStatusDOM();
      },
      onPeersChange: (peers) => {
        this.peers = peers;
        this.updatePeersDOM();
      },
      onChatMessage: (msg, isHistorySync) => {
        if (this.messageIds.has(msg.id)) return;
        this.messageIds.add(msg.id);
        this.messages.push(msg);
        if (isHistorySync) {
          this.messages.sort((a, b) => a.timestamp - b.timestamp);
        }
        this.appendOrRefreshMessages();
      },
      onMessageAck: (messageId, ackPeerId) => {
        const target = this.messages.find((m) => m.id === messageId);
        if (target && !target.ackedBy.includes(ackPeerId)) {
          target.ackedBy.push(ackPeerId);
          const ackEl = this.root.querySelector(`[data-ack-id="${messageId}"]`);
          if (ackEl) {
            ackEl.textContent = `✓✓ ${target.ackedBy.length}`;
          }
        }
      },
      onTypingChange: (typingPeers) => {
        this.typingPeers = typingPeers;
        this.updateTypingDOM();
      },
      onSystemLog: (text) => {
        const sysMsg: ChatMessage = {
          id: generateUUID(),
          roomId: this.roomId,
          senderId: 'system',
          senderName: 'SYS',
          text,
          timestamp: Date.now(),
          system: true,
          ackedBy: [],
        };
        this.messages.push(sysMsg);
        this.appendOrRefreshMessages();
      },
      getRecentRoomMessages: () => {
        return this.messages.filter((m) => !m.system && !m.targetPeerId);
      },
    });

    this.engine.start();
  }

  private showToast(text: string): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    let el = this.root.querySelector('.toast') as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      this.root.appendChild(el);
    }
    el.textContent = text;
    this.toastTimer = window.setTimeout(() => {
      el?.remove();
    }, 2400);
  }

  private switchRoom(targetRoom: string): void {
    const normalized = normalizeRoomId(targetRoom);
    if (normalized === this.roomId) {
      this.mobileDrawerOpen = false;
      this.render();
      return;
    }
    this.roomId = normalized;
    this.syncUrlWithRoom(this.roomId);
    this.replyTo = undefined;
    this.whisperTarget = undefined;
    this.mobileDrawerOpen = false;
    this.messages = [];
    this.messageIds.clear();
    this.engine.switchRoom(this.roomId);
    this.render();
    this.scrollToBottom();
  }

  private handleSendMessage(rawInput: string): void {
    const text = rawInput.trim();
    if (!text) return;

    if (text.startsWith('/')) {
      const parts = text.split(' ');
      const cmd = parts[0].toLowerCase();
      const argStr = parts.slice(1).join(' ').trim();

      if (cmd === '/help') {
        this.activeModal = 'help';
        this.renderModal();
        return;
      }
      if (cmd === '/clear') {
        this.messages = [];
        this.messageIds.clear();
        this.appendOrRefreshMessages();
        this.showToast('Cleared chat view');
        return;
      }
      if (cmd === '/nick' && argStr) {
        this.profile.nickname = argStr.slice(0, 24);
        saveUserProfile(this.profile);
        this.engine.updateProfile(this.profile);
        this.render();
        this.showToast(`Nickname set to ${this.profile.nickname}`);
        return;
      }
      if (cmd === '/room') {
        const nextRoom = argStr || generateRoomCode();
        this.switchRoom(nextRoom);
        return;
      }
      if (cmd === '/shrug') {
        this.dispatchUserChat(`${argStr} ¯\\_(ツ)_/¯`.trim());
        return;
      }
      if (cmd === '/me' && argStr) {
        this.dispatchUserChat(`* ${this.profile.nickname} ${argStr} *`);
        return;
      }
    }

    this.dispatchUserChat(text);
  }

  private dispatchUserChat(text: string): void {
    const msg = this.engine.sendChatMessage(text, this.replyTo, this.whisperTarget);
    this.messageIds.add(msg.id);
    this.messages.push(msg);

    this.replyTo = undefined;
    this.engine.sendTyping(false);
    this.updateContextBannerDOM();
    this.appendOrRefreshMessages();
    this.scrollToBottom();
  }

  // =========================================================================
  // DOM RENDERING & INCREMENTAL UPDATES
  // =========================================================================
  public render(): void {
    this.root.innerHTML = `
      <div class="layout">
        ${this.mobileDrawerOpen ? `<div class="drawer-backdrop" id="drawer-backdrop"></div>` : ''}
        <aside class="sidebar ${this.mobileDrawerOpen ? 'open' : ''}" id="sidebar">
          <div class="sidebar-header">
            <div class="brand">
              <span class="status-dot ${this.signalingState.status}" id="sig-dot"></span>
              <span>revchat // p2p</span>
            </div>
            <div style="display:flex;gap:4px;">
              <button class="small" id="btn-theme" title="Toggle Dark/Light Theme">
                ${this.profile.theme === 'dark' ? 'LIGHT' : 'DARK'}
              </button>
              <button class="small mobile-only" id="btn-close-drawer">✕</button>
            </div>
          </div>

          <!-- Identity Section -->
          <div class="side-section">
            <div class="sec-title">
              <span>Identity</span>
              <span id="sig-label">${this.getSignalingBadgeText()}</span>
            </div>
            <div class="field-row">
              <input type="text" id="input-nick" value="${this.escapeAttr(this.profile.nickname)}" maxlength="24" placeholder="Nickname" />
              <button id="btn-save-nick">SET</button>
            </div>
            <div class="kv-line">
              <span>My Peer Code:</span>
              <span style="display:flex;align-items:center;gap:4px;">
                <code class="code-pill" id="my-peer-code">${this.escapeHtml(this.profile.clientId.toUpperCase())}</code>
                <button class="small" id="btn-copy-peer">COPY</button>
              </span>
            </div>
          </div>

          <!-- Room Section -->
          <div class="side-section">
            <div class="sec-title">
              <span>Room Channel</span>
              <button class="small" id="btn-new-room">+ RANDOM</button>
            </div>
            <div class="field-row">
              <input type="text" id="input-room" value="${this.escapeAttr(this.roomId)}" maxlength="32" placeholder="ROOM-CODE" />
              <button class="primary" id="btn-join-room">JOIN</button>
            </div>
          </div>

          <!-- P2P Connect Tools -->
          <div class="side-section">
            <div class="sec-title">
              <span>Connect Peers</span>
            </div>
            <div class="field-row">
              <input type="text" id="input-direct-peer" placeholder="Peer Code (e.g. 8F9A2B)" />
              <button id="btn-dial-peer">DIAL</button>
            </div>
            <div class="field-row" style="margin-top:6px;">
              <button style="width:100%" id="btn-open-invite">QR / INVITE LINK</button>
            </div>
          </div>

          <!-- Connected Peers List -->
          <div class="side-section" style="flex:1;border-bottom:none;">
            <div class="sec-title">
              <span>Connected Peers (<span id="peer-count-side">${this.peers.length}</span>)</span>
              <span class="badge">${this.signalingState.isBeaconHost ? 'HOST' : 'MESH'}</span>
            </div>
            <div class="peer-list" id="peer-list-container">
              ${this.renderPeersListHtml()}
            </div>
          </div>
        </aside>

        <!-- Main Chat Area -->
        <main class="chat-pane">
          <header class="chat-topbar">
            <div class="topbar-left">
              <button class="mobile-only" id="btn-open-drawer">
                ≡ <span id="mobile-peer-count">${this.peers.length}</span>
              </button>
              <span class="room-badge" id="topbar-room-title">#${this.escapeHtml(this.roomId)}</span>
              <span class="badge ok" id="topbar-peer-badge">${this.peers.length} peer${this.peers.length === 1 ? '' : 's'}</span>
            </div>
            <div class="topbar-actions">
              <button class="small" id="btn-toggle-search" title="Search Messages">FIND</button>
              <button class="small" id="btn-help" title="Commands & Help">HELP</button>
            </div>
          </header>

          ${
            this.searchOpen
              ? `
            <div class="search-bar">
              <input type="search" id="input-search" value="${this.escapeAttr(this.searchQuery)}" placeholder="Filter messages by text or author..." />
              <button class="small" id="btn-close-search">CLOSE</button>
            </div>
          `
              : ''
          }

          <div class="message-stream" id="message-stream">
            ${this.renderMessagesHtml()}
          </div>

          <button class="jump-bottom-btn" id="btn-jump-bottom" style="display:none;">
            ↓ Jump to latest
          </button>

          <div id="composer-context-container">
            ${this.renderContextBannerHtml()}
          </div>

          <div class="typing-bar" id="typing-bar">
            ${this.renderTypingText()}
          </div>

          <form class="composer" id="composer-form">
            <textarea
              id="composer-input"
              rows="1"
              placeholder="Message #${this.escapeAttr(this.roomId)} (Enter to send, Shift+Enter newline, /help)"
            ></textarea>
            <button type="submit" class="primary send-btn">SEND</button>
          </form>
        </main>
      </div>
      <div id="modal-root"></div>
    `;

    this.bindEvents();
    this.renderModal();
  }

  private renderPeersListHtml(): string {
    if (this.peers.length === 0) {
      return `
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--fg-muted);padding:8px 0;">
          No remote peers connected yet.<br/>
          • Open another tab to test instant local mesh<br/>
          • Or share <b>QR / Invite Link</b> with mobile/desktop
        </div>
      `;
    }

    return this.peers
      .map((p) => {
        const transportLabel = p.transport === 'local-broadcast' ? 'LOCAL' : 'WEBRTC';
        const rttLabel = p.rttMs !== null ? `${p.rttMs}ms` : '...';
        const isWhispering = this.whisperTarget?.peerId === p.peerId;
        return `
          <div class="peer-item">
            <div class="peer-meta">
              <div class="peer-name">${this.escapeHtml(p.nickname)}</div>
              <div class="peer-sub">
                <span>${transportLabel}</span>
                <span>•</span>
                <span>${rttLabel}</span>
                ${p.isRoomBeaconHolder ? `<span class="badge">HOST</span>` : ''}
              </div>
            </div>
            <button
              class="small ${isWhispering ? 'primary' : ''}"
              data-whisper-id="${this.escapeAttr(p.peerId)}"
              data-whisper-name="${this.escapeAttr(p.nickname)}"
              title="Send private 1:1 message"
            >
              ${isWhispering ? 'DM ON' : 'DM'}
            </button>
          </div>
        `;
      })
      .join('');
  }

  private renderMessagesHtml(): string {
    const q = this.searchQuery.trim().toLowerCase();
    const filtered = q
      ? this.messages.filter(
          (m) =>
            m.text.toLowerCase().includes(q) || m.senderName.toLowerCase().includes(q)
        )
      : this.messages;

    if (filtered.length === 0) {
      return `
        <div class="empty-state">
          <h3>#${this.escapeHtml(this.roomId)} — P2P Channel Ready</h3>
          <ul>
            <li><b>Same Browser:</b> Open this URL in a second tab for instant local P2P chat.</li>
            <li><b>Mobile / Remote:</b> Tap <b>QR / INVITE LINK</b> to scan QR code or share room link.</li>
            <li><b>Slash Commands:</b> <code>/nick name</code>, <code>/room code</code>, <code>/clear</code>, <code>/help</code></li>
          </ul>
        </div>
      `;
    }

    return filtered
      .map((m) => {
        const timeStr = new Date(m.timestamp).toLocaleTimeString([], {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });

        if (m.system) {
          return `
            <div class="msg-row system">
              [${timeStr}] * ${this.escapeHtml(m.text)}
            </div>
          `;
        }

        const isSelf =
          m.senderId === this.signalingState.myPeerId ||
          m.senderId.startsWith(`revchat-p-${this.profile.clientId.toLowerCase()}`);

        const whisperTag = m.targetPeerId
          ? `<span class="badge">[DM → ${this.escapeHtml(m.targetPeerName || 'peer')}]</span> `
          : '';

        const ackText = isSelf
          ? m.ackedBy.length > 0
            ? `✓✓ ${m.ackedBy.length}`
            : '✓'
          : '';

        return `
          <div class="msg-row ${isSelf ? 'self' : ''} ${m.targetPeerId ? 'whisper' : ''}">
            <div class="msg-header">
              <div>
                <span class="msg-author ${isSelf ? 'self' : ''}">${this.escapeHtml(m.senderName)}</span>
                ${whisperTag}
                <span class="msg-time">${timeStr}</span>
              </div>
              <div class="msg-meta-right">
                ${
                  isSelf
                    ? `<span class="msg-ack" data-ack-id="${this.escapeAttr(m.id)}">${ackText}</span>`
                    : ''
                }
                <button
                  class="small msg-reply-btn"
                  data-reply-id="${this.escapeAttr(m.id)}"
                  data-reply-sender="${this.escapeAttr(m.senderName)}"
                  data-reply-text="${this.escapeAttr(m.text.slice(0, 80))}"
                >
                  reply
                </button>
              </div>
            </div>
            ${
              m.replyTo
                ? `<div class="msg-quote">@${this.escapeHtml(m.replyTo.senderName)}: ${this.escapeHtml(m.replyTo.text)}</div>`
                : ''
            }
            <div class="msg-body">${this.formatMessageBody(m.text)}</div>
          </div>
        `;
      })
      .join('');
  }

  private renderContextBannerHtml(): string {
    if (!this.replyTo && !this.whisperTarget) return '';
    const parts: string[] = [];
    if (this.whisperTarget) {
      parts.push(`Private DM to <b>@${this.escapeHtml(this.whisperTarget.nickname)}</b>`);
    }
    if (this.replyTo) {
      parts.push(
        `Replying to <b>@${this.escapeHtml(this.replyTo.senderName)}</b>: "${this.escapeHtml(
          this.replyTo.text.slice(0, 50)
        )}"`
      );
    }
    return `
      <div class="composer-context">
        <span>${parts.join(' • ')}</span>
        <button class="small" id="btn-clear-context">✕ CANCEL</button>
      </div>
    `;
  }

  private renderTypingText(): string {
    if (this.typingPeers.length === 0) {
      return `<span>Ready • ${this.signalingState.status === 'ready' ? 'WebRTC Online' : 'Local Mode'}</span>`;
    }
    const names = this.typingPeers.map((t) => this.escapeHtml(t.nickname)).join(', ');
    return `<span><b>${names}</b> typing...</span>`;
  }

  private getSignalingBadgeText(): string {
    if (this.signalingState.status === 'ready') {
      return this.signalingState.isBeaconHost ? 'ONLINE (HOST)' : 'ONLINE';
    }
    if (this.signalingState.status === 'initializing') return 'CONNECTING...';
    return 'LOCAL';
  }

  private updateStatusDOM(): void {
    const dot = this.root.querySelector('#sig-dot');
    if (dot) {
      dot.className = `status-dot ${this.signalingState.status}`;
    }
    const label = this.root.querySelector('#sig-label');
    if (label) {
      label.textContent = this.getSignalingBadgeText();
    }
    this.updateTypingDOM();
  }

  private updatePeersDOM(): void {
    const listEl = this.root.querySelector('#peer-list-container');
    if (listEl) {
      listEl.innerHTML = this.renderPeersListHtml();
      this.bindPeerItemEvents();
    }
    const sideCount = this.root.querySelector('#peer-count-side');
    if (sideCount) sideCount.textContent = String(this.peers.length);

    const mobileCount = this.root.querySelector('#mobile-peer-count');
    if (mobileCount) mobileCount.textContent = String(this.peers.length);

    const topBadge = this.root.querySelector('#topbar-peer-badge');
    if (topBadge) {
      topBadge.textContent = `${this.peers.length} peer${this.peers.length === 1 ? '' : 's'}}`;
      topBadge.textContent = `${this.peers.length} peer${this.peers.length === 1 ? '' : 's'}`;
    }
  }

  private updateContextBannerDOM(): void {
    const container = this.root.querySelector('#composer-context-container');
    if (container) {
      container.innerHTML = this.renderContextBannerHtml();
      const clearBtn = container.querySelector('#btn-clear-context');
      clearBtn?.addEventListener('click', () => {
        this.replyTo = undefined;
        this.whisperTarget = undefined;
        this.updateContextBannerDOM();
        this.updatePeersDOM();
      });
    }
  }

  private updateTypingDOM(): void {
    const bar = this.root.querySelector('#typing-bar');
    if (bar) {
      bar.innerHTML = this.renderTypingText();
    }
  }

  private appendOrRefreshMessages(): void {
    const stream = this.root.querySelector('#message-stream') as HTMLElement | null;
    if (!stream) return;

    const wasAtBottom =
      stream.scrollHeight - stream.scrollTop - stream.clientHeight < 65;
    stream.innerHTML = this.renderMessagesHtml();
    this.bindMessageStreamEvents();

    if (wasAtBottom) {
      this.scrollToBottom();
    } else {
      this.unreadWhileScrolled++;
      this.updateJumpButtonDOM();
    }
  }

  private scrollToBottom(): void {
    const stream = this.root.querySelector('#message-stream') as HTMLElement | null;
    if (!stream) return;
    stream.scrollTop = stream.scrollHeight;
    this.isAtBottom = true;
    this.unreadWhileScrolled = 0;
    this.updateJumpButtonDOM();
  }

  private updateJumpButtonDOM(): void {
    const btn = this.root.querySelector('#btn-jump-bottom') as HTMLElement | null;
    if (!btn) return;
    if (!this.isAtBottom && this.unreadWhileScrolled > 0) {
      btn.style.display = 'inline-flex';
      btn.textContent = `↓ ${this.unreadWhileScrolled} new message${
        this.unreadWhileScrolled > 1 ? 's' : ''
      }`;
    } else if (!this.isAtBottom) {
      btn.style.display = 'inline-flex';
      btn.textContent = '↓ Bottom';
    } else {
      btn.style.display = 'none';
    }
  }

  // =========================================================================
  // MODALS (INVITE / QR, HELP)
  // =========================================================================
  private async openInviteModal(): Promise<void> {
    this.activeModal = 'invite';
    this.inviteQrSvg = await generateQrSvg(this.getInviteUrl());
    this.renderModal();
  }

  private renderModal(): void {
    const modalRoot = this.root.querySelector('#modal-root');
    if (!modalRoot) return;

    if (this.activeModal === 'none') {
      modalRoot.innerHTML = '';
      return;
    }

    if (this.activeModal === 'invite') {
      const inviteUrl = this.getInviteUrl();
      const canNativeShare = typeof navigator.share === 'function';
      modalRoot.innerHTML = `
        <div class="modal-backdrop" id="modal-backdrop">
          <div class="modal">
            <div class="modal-header">
              <span>INVITE TO #${this.escapeHtml(this.roomId)}</span>
              <button class="small" id="btn-modal-close">✕</button>
            </div>
            <div class="modal-body">
              <div class="qr-box">${this.inviteQrSvg}</div>
              <div style="text-align:center;font-family:var(--font-mono);font-size:12px;">
                Scan with mobile camera to join <b>#${this.escapeHtml(this.roomId)}</b> immediately
              </div>
              <div class="step-block">
                <div class="step-title">Shareable Invite Link</div>
                <div class="field-row">
                  <input type="text" readonly value="${this.escapeAttr(inviteUrl)}" id="invite-url-input" />
                  <button class="primary" id="btn-copy-invite">COPY</button>
                  ${canNativeShare ? `<button id="btn-native-share">SHARE</button>` : ''}
                </div>
              </div>
              <div class="step-block">
                <div class="step-title">Room Code & Peer Code</div>
                <div class="kv-line">
                  <span>Room Code:</span>
                  <code class="code-pill">${this.escapeHtml(this.roomId)}</code>
                </div>
                <div class="kv-line">
                  <span>Your Direct Peer ID:</span>
                  <code class="code-pill">${this.escapeHtml(this.signalingState.myPeerId)}</code>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      modalRoot.querySelector('#btn-modal-close')?.addEventListener('click', () => {
        this.activeModal = 'none';
        this.renderModal();
      });
      modalRoot.querySelector('#modal-backdrop')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
          this.activeModal = 'none';
          this.renderModal();
        }
      });
      modalRoot.querySelector('#btn-copy-invite')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(inviteUrl);
        this.showToast('Invite URL copied to clipboard');
      });
      modalRoot.querySelector('#btn-native-share')?.addEventListener('click', () => {
        navigator
          .share({
            title: `Join #${this.roomId} on revchat`,
            text: `Join my P2P chat room #${this.roomId}`,
            url: inviteUrl,
          })
          .catch(() => {});
      });
      return;
    }

    if (this.activeModal === 'help') {
      modalRoot.innerHTML = `
        <div class="modal-backdrop" id="modal-backdrop">
          <div class="modal">
            <div class="modal-header">
              <span>REVCHAT // GUIDE & COMMANDS</span>
              <button class="small" id="btn-modal-close">✕</button>
            </div>
            <div class="modal-body">
              <div class="step-block">
                <div class="step-title">How P2P Connectivity Works</div>
                <div style="font-size:12px;">
                  1. <b>Room Code Mesh:</b> Peers on the same Room Code discover each other automatically via WebRTC rendezvous and form a direct P2P mesh.<br/>
                  2. <b>Same-Device Instant Mesh:</b> Multiple tabs in the same browser connect in &lt;1ms via BroadcastChannel + WebRTC.
                </div>
              </div>
              <div class="step-block">
                <div class="step-title">Slash Commands</div>
                <div style="font-family:var(--font-mono);font-size:12px;display:flex;flex-direction:column;gap:4px;">
                  <div><code>/nick &lt;name&gt;</code> — Change your display nickname</div>
                  <div><code>/room &lt;code&gt;</code> — Switch to or create a room</div>
                  <div><code>/me &lt;action&gt;</code> — Send an action message</div>
                  <div><code>/shrug</code> — Append ¯\\_(ツ)_/¯</div>
                  <div><code>/clear</code> — Clear current chat view</div>
                  <div><code>/help</code> — Show this dialog</div>
                </div>
              </div>
              <div style="display:flex;gap:6px;justify-content:flex-end;">
                <button id="btn-modal-clear">CLEAR ROOM</button>
              </div>
            </div>
          </div>
        </div>
      `;

      modalRoot.querySelector('#btn-modal-close')?.addEventListener('click', () => {
        this.activeModal = 'none';
        this.renderModal();
      });
      modalRoot.querySelector('#modal-backdrop')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
          this.activeModal = 'none';
          this.renderModal();
        }
      });
      modalRoot.querySelector('#btn-modal-clear')?.addEventListener('click', () => {
        this.messages = [];
        this.messageIds.clear();
        this.appendOrRefreshMessages();
        this.activeModal = 'none';
        this.renderModal();
      });
    }
  }

  // =========================================================================
  // EVENT BINDINGS
  // =========================================================================
  private bindEvents(): void {
    // Mobile drawer controls
    this.root.querySelector('#btn-open-drawer')?.addEventListener('click', () => {
      this.mobileDrawerOpen = true;
      this.render();
    });
    this.root.querySelector('#btn-close-drawer')?.addEventListener('click', () => {
      this.mobileDrawerOpen = false;
      this.render();
    });
    this.root.querySelector('#drawer-backdrop')?.addEventListener('click', () => {
      this.mobileDrawerOpen = false;
      this.render();
    });

    // Theme
    this.root.querySelector('#btn-theme')?.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      this.profile.theme = current === 'dark' ? 'light' : 'dark';
      saveUserProfile(this.profile);
      this.applyTheme();
      this.render();
    });

    // Nickname
    const saveNick = () => {
      const input = this.root.querySelector('#input-nick') as HTMLInputElement | null;
      const val = input?.value.trim();
      if (val) {
        this.profile.nickname = val.slice(0, 24);
        saveUserProfile(this.profile);
        this.engine.updateProfile(this.profile);
        this.showToast(`Saved nickname: ${this.profile.nickname}`);
      }
    };
    this.root.querySelector('#btn-save-nick')?.addEventListener('click', saveNick);
    this.root.querySelector('#input-nick')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        saveNick();
      }
    });

    // Copy My Peer Code
    this.root.querySelector('#btn-copy-peer')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(this.profile.clientId.toUpperCase());
      this.showToast('Peer code copied!');
    });

    // Room Join / Random
    const joinRoomFromInput = () => {
      const input = this.root.querySelector('#input-room') as HTMLInputElement | null;
      if (input && input.value.trim()) {
        this.switchRoom(input.value.trim());
      }
    };
    this.root.querySelector('#btn-join-room')?.addEventListener('click', joinRoomFromInput);
    this.root.querySelector('#input-room')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        joinRoomFromInput();
      }
    });
    this.root.querySelector('#btn-new-room')?.addEventListener('click', () => {
      this.switchRoom(generateRoomCode());
    });

    // Direct Peer Dial
    const dialPeer = () => {
      const input = this.root.querySelector('#input-direct-peer') as HTMLInputElement | null;
      const val = input?.value.trim() || '';
      if (!val) return;
      const ok = this.engine.connectToDirectPeer(val);
      if (ok) {
        if (input) input.value = '';
        this.mobileDrawerOpen = false;
        this.render();
        this.showToast(`Dialing peer ${val}...`);
      } else {
        this.showToast('Could not dial peer (check code)');
      }
    };
    this.root.querySelector('#btn-dial-peer')?.addEventListener('click', dialPeer);
    this.root.querySelector('#input-direct-peer')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        dialPeer();
      }
    });

    // Modals
    this.root.querySelector('#btn-open-invite')?.addEventListener('click', () => {
      this.mobileDrawerOpen = false;
      this.openInviteModal();
    });
    this.root.querySelector('#btn-help')?.addEventListener('click', () => {
      this.activeModal = 'help';
      this.renderModal();
    });

    // Search
    this.root.querySelector('#btn-toggle-search')?.addEventListener('click', () => {
      this.searchOpen = !this.searchOpen;
      if (!this.searchOpen) this.searchQuery = '';
      this.render();
      if (this.searchOpen) {
        (this.root.querySelector('#input-search') as HTMLInputElement | null)?.focus();
      }
    });
    this.root.querySelector('#btn-close-search')?.addEventListener('click', () => {
      this.searchOpen = false;
      this.searchQuery = '';
      this.render();
    });
    this.root.querySelector('#input-search')?.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.appendOrRefreshMessages();
    });

    // Message Stream Scroll & Jump
    const stream = this.root.querySelector('#message-stream') as HTMLElement | null;
    stream?.addEventListener('scroll', () => {
      const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 50;
      this.isAtBottom = atBottom;
      if (atBottom) {
        this.unreadWhileScrolled = 0;
      }
      this.updateJumpButtonDOM();
    });
    this.root.querySelector('#btn-jump-bottom')?.addEventListener('click', () => {
      this.scrollToBottom();
    });

    // Composer Input & Submit
    const form = this.root.querySelector('#composer-form') as HTMLFormElement | null;
    const textarea = this.root.querySelector('#composer-input') as HTMLTextAreaElement | null;

    const autoResize = () => {
      if (!textarea) return;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(120, textarea.scrollHeight)}px`;
    };

    textarea?.addEventListener('input', () => {
      autoResize();
      const now = Date.now();
      if (textarea.value.trim().length > 0) {
        if (now - this.lastTypingSentAt > 2000) {
          this.lastTypingSentAt = now;
          this.engine.sendTyping(true);
        }
        if (this.stopTypingTimer) clearTimeout(this.stopTypingTimer);
        this.stopTypingTimer = window.setTimeout(() => {
          this.engine.sendTyping(false);
        }, 3000);
      } else {
        this.engine.sendTyping(false);
      }
    });

    textarea?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.trim()) {
          const val = textarea.value;
          textarea.value = '';
          autoResize();
          this.handleSendMessage(val);
        }
      }
    });

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (textarea && textarea.value.trim()) {
        const val = textarea.value;
        textarea.value = '';
        autoResize();
        this.handleSendMessage(val);
        textarea.focus();
      }
    });

    this.bindPeerItemEvents();
    this.bindMessageStreamEvents();
    this.updateContextBannerDOM();
  }

  private bindPeerItemEvents(): void {
    this.root.querySelectorAll('[data-whisper-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const peerId = btn.getAttribute('data-whisper-id') || '';
        const nickname = btn.getAttribute('data-whisper-name') || 'peer';
        if (this.whisperTarget?.peerId === peerId) {
          this.whisperTarget = undefined;
        } else {
          this.whisperTarget = { peerId, nickname };
        }
        this.mobileDrawerOpen = false;
        this.updatePeersDOM();
        this.updateContextBannerDOM();
        (this.root.querySelector('#composer-input') as HTMLTextAreaElement | null)?.focus();
      });
    });
  }

  private bindMessageStreamEvents(): void {
    this.root.querySelectorAll('[data-reply-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-reply-id') || '';
        const senderName = btn.getAttribute('data-reply-sender') || '';
        const text = btn.getAttribute('data-reply-text') || '';
        this.replyTo = { id, senderName, text };
        this.updateContextBannerDOM();
        (this.root.querySelector('#composer-input') as HTMLTextAreaElement | null)?.focus();
      });
    });
  }

  // =========================================================================
  // FORMATTING HELPERS
  // =========================================================================
  private formatMessageBody(raw: string): string {
    let safe = this.escapeHtml(raw);
    safe = safe.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    safe = safe.replace(
      /\b(https?:\/\/[a-zA-Z0-9._~:/?#\[\]@!$'()*+,;=%-]+)\b/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return safe;
  }

  private escapeHtml(str: string): string {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private escapeAttr(str: string): string {
    return this.escapeHtml(str);
  }
}

const appRoot = document.getElementById('app');
if (appRoot) {
  new RevChatApp(appRoot);
}
