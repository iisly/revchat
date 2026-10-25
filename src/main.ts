import { P2PEngine } from './p2p-engine';
import { generateQrSvg } from './qrcode';
import { MAX_NICKNAME_LENGTH, sanitizeString } from './security';
import {
  createSessionProfile,
  generateRoomCode,
  generateUUID,
  normalizeRoomId,
} from './storage';
import { ChatMessage, PeerInfo, SignalingState, UserProfile } from './types';

const MAX_MEMORY_MESSAGES = 1000;

const EIGHT_BALL_ANSWERS = [
  'It is certain.',
  'Without a doubt.',
  'Yes — definitely.',
  'Most likely.',
  'Outlook good.',
  'Ask again later.',
  'Better not tell you now.',
  'Cannot predict now.',
  'Don’t count on it.',
  'My reply is no.',
  'Very doubtful.',
];

interface SlashCommandDef {
  cmd: string;
  usage: string;
  desc: string;
  needsArgs: boolean;
}

const ASCII_EMOTES: Record<string, string> = {
  '/flip': '(╯°□°）╯︵ ┻━┻',
  '/unflip': '┬─┬ ノ( ゜-゜ノ)',
  '/shrug': '¯\\_(ツ)_/¯',
  '/lenny': '( ͡° ͜ʖ ͡°)',
  '/look': 'ಠ_ಠ',
  '/gib': '༼ つ ◕_◕ ༽つ',
  '/sparkle': '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧',
  '/fight': "(ง'̀-'́)ง",
  '/bear': 'ʕ•ᴥ•ʔ',
  '/cry': '(ಥ﹏ಥ)',
  '/love': '(｡♥‿♥｡)',
  '/dance': '♪┏(・o･)┛♪',
};

const FONT_SIZES: Record<'s' | 'm' | 'l', { label: string; px: string }> = {
  s: { label: 'S', px: '14px' },
  m: { label: 'M', px: '17px' },
  l: { label: 'L', px: '20px' },
};

const SLASH_COMMANDS: SlashCommandDef[] = [
  { cmd: '/roll', usage: '/roll [max]', desc: 'Roll a dice (default 1-100)', needsArgs: false },
  { cmd: '/coin', usage: '/coin', desc: 'Flip a coin (HEADS / TAILS)', needsArgs: false },
  { cmd: '/rps', usage: '/rps [r|p|s]', desc: 'Throw Rock, Paper, or Scissors (random if omitted)', needsArgs: false },
  { cmd: '/8ball', usage: '/8ball <question>', desc: 'Ask the Magic 8-Ball', needsArgs: true },
  { cmd: '/pick', usage: '/pick <a, b, ...>', desc: 'Randomly pick one from multiple options', needsArgs: true },
  { cmd: '/shout', usage: '/shout <text>', desc: 'Send big bold announcement', needsArgs: true },
  { cmd: '/flip', usage: '/flip [text]', desc: 'Append (╯°□°）╯︵ ┻━┻', needsArgs: false },
  { cmd: '/unflip', usage: '/unflip [text]', desc: 'Append ┬─┬ ノ( ゜-゜ノ)', needsArgs: false },
  { cmd: '/shrug', usage: '/shrug [text]', desc: 'Append ¯\\_(ツ)_/¯', needsArgs: false },
  { cmd: '/lenny', usage: '/lenny [text]', desc: 'Append ( ͡° ͜ʖ ͡°)', needsArgs: false },
  { cmd: '/look', usage: '/look [text]', desc: 'Append ಠ_ಠ', needsArgs: false },
  { cmd: '/gib', usage: '/gib [text]', desc: 'Append ༼ つ ◕_◕ ༽つ', needsArgs: false },
  { cmd: '/sparkle', usage: '/sparkle [text]', desc: 'Append (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧', needsArgs: false },
  { cmd: '/fight', usage: '/fight [text]', desc: "Append (ง'̀-'́)ง", needsArgs: false },
  { cmd: '/bear', usage: '/bear [text]', desc: 'Append ʕ•ᴥ•ʔ', needsArgs: false },
  { cmd: '/cry', usage: '/cry [text]', desc: 'Append (ಥ﹏ಥ)', needsArgs: false },
  { cmd: '/love', usage: '/love [text]', desc: 'Append (｡♥‿♥｡)', needsArgs: false },
  { cmd: '/dance', usage: '/dance [text]', desc: 'Append ♪┏(・o･)┛♪', needsArgs: false },
  { cmd: '/me', usage: '/me <action>', desc: 'Send an action message', needsArgs: true },
  { cmd: '/nick', usage: '/nick <name>', desc: 'Change your nickname', needsArgs: true },
  { cmd: '/room', usage: '/room [code]', desc: 'Switch room (or random room if omitted)', needsArgs: false },
  { cmd: '/follow', usage: '/follow <code>', desc: 'Follow a peer into their active room', needsArgs: true },
  { cmd: '/size', usage: '/size [s|m|l]', desc: 'Change main panel font size (or cycle)', needsArgs: false },
  { cmd: '/clear', usage: '/clear', desc: 'Clear local chat view', needsArgs: false },
  { cmd: '/help', usage: '/help', desc: 'Open commands & help guide', needsArgs: false },
];

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
  private slashMenuIndex = 0;
  private slashMenuDismissed = false;
  private fontSizeKey: 's' | 'm' | 'l' = 's';

  // Timers
  private lastTypingSentAt = 0;
  private stopTypingTimer: number | null = null;
  private toastTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.profile = createSessionProfile();
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
    this.setupLifecycleCleanup();
    this.render();
    this.initEngine();
  }

  private setupLifecycleCleanup(): void {
    const cleanup = () => {
      if (this.engine) {
        this.engine.destroy();
      }
    };
    window.addEventListener('pagehide', cleanup);
    window.addEventListener('beforeunload', cleanup);
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
      url.searchParams.delete('peer');
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
    if (this.profile.theme === 'auto') {
      this.profile.theme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    document.documentElement.setAttribute('data-theme', this.profile.theme);
  }

  private pushMessageToMemory(msg: ChatMessage): boolean {
    if (this.messageIds.has(msg.id)) return false;
    this.messageIds.add(msg.id);
    let evicted = false;
    this.messages.push(msg);
    if (this.messages.length > MAX_MEMORY_MESSAGES) {
      const removed = this.messages.shift();
      if (removed) {
        this.messageIds.delete(removed.id);
        evicted = true;
      }
    }
    this.appendSingleMessageDOM(msg, evicted);
    return true;
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
            this.engine.connectToDirectPeer(peerToDial, true);
          }
        }
        this.updateStatusDOM();
      },
      onPeersChange: (peers) => {
        this.peers = peers;
        this.updatePeersDOM();
      },
      onChatMessage: (msg) => {
        this.pushMessageToMemory(msg);
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
        this.pushMessageToMemory(sysMsg);
      },
      onRoomFollowed: (newRoomId, peerNickname) => {
        this.roomId = newRoomId;
        this.syncUrlWithRoom(this.roomId);
        this.replyTo = undefined;
        this.whisperTarget = undefined;
        this.mobileDrawerOpen = false;
        this.messages = [];
        this.messageIds.clear();
        this.render();
        this.showToast(`Joined ${peerNickname} in #${newRoomId}`);
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

  private applyFontSize(key?: 's' | 'm' | 'l'): void {
    const order: ('s' | 'm' | 'l')[] = ['s', 'm', 'l'];
    if (key && FONT_SIZES[key]) {
      this.fontSizeKey = key;
    } else {
      const nextIdx = (order.indexOf(this.fontSizeKey) + 1) % order.length;
      this.fontSizeKey = order[nextIdx];
    }
    const spec = FONT_SIZES[this.fontSizeKey];
    document.documentElement.style.setProperty('--msg-font-size', spec.px);
    this.root.querySelectorAll('[data-size-key]').forEach((el) => {
      const k = el.getAttribute('data-size-key');
      el.classList.toggle('primary', k === this.fontSizeKey);
    });
    this.showToast(`Font size: ${spec.label} (${spec.px})`);
  }

  private expandInlineEmotes(text: string): string {
    return text.replace(/(^|\s)(\/[a-z0-9]+)(?=\s|$)/gi, (full, lead, token) => {
      const emote = ASCII_EMOTES[token.toLowerCase()];
      return emote ? `${lead}${emote}` : full;
    });
  }

  private handleSendMessage(rawInput: string): void {
    const text = rawInput.trim();
    if (!text) return;

    if (text.startsWith('/') && this.executeSlashCommand(text)) {
      return;
    }

    this.dispatchUserChat(this.expandInlineEmotes(text));
  }

  private executeSlashCommand(text: string): boolean {
    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();
    const argStr = parts.slice(1).join(' ').trim();
    const nick = this.profile.nickname;

    switch (cmd) {
      case '/help': {
        this.activeModal = 'help';
        this.renderModal();
        return true;
      }
      case '/clear': {
        this.messages = [];
        this.messageIds.clear();
        this.appendOrRefreshMessages();
        this.showToast('Cleared chat view');
        return true;
      }
      case '/nick': {
        const cleanNick = sanitizeString(argStr, MAX_NICKNAME_LENGTH).trim();
        if (!cleanNick) {
          this.showToast('Usage: /nick <name>');
          return true;
        }
        this.profile.nickname = cleanNick;
        this.engine.updateProfile(this.profile);
        this.render();
        this.showToast(`Nickname set to ${this.profile.nickname}`);
        return true;
      }
      case '/room': {
        this.switchRoom(argStr || generateRoomCode());
        return true;
      }
      case '/follow': {
        if (!argStr) {
          this.showToast('Usage: /follow <peer-code>');
          return true;
        }
        const ok = this.engine.connectToDirectPeer(argStr, true);
        if (ok) {
          this.showToast(`Following ${argStr} into their room...`);
        } else {
          this.showToast('Could not follow peer (check code)');
        }
        return true;
      }
      case '/size': {
        const arg = argStr.toLowerCase() as 's' | 'm' | 'l';
        if (arg === 's' || arg === 'm' || arg === 'l') {
          this.applyFontSize(arg);
        } else {
          this.applyFontSize();
        }
        return true;
      }
      case '/roll': {
        const max = Math.min(1_000_000, Math.max(2, parseInt(argStr, 10) || 100));
        const val = Math.floor(Math.random() * max) + 1;
        this.dispatchUserChat(`🎲 ${nick} rolled ${val} (1-${max})`);
        return true;
      }
      case '/coin': {
        const side = Math.random() < 0.5 ? 'HEADS' : 'TAILS';
        this.dispatchUserChat(`🪙 ${nick} flipped a coin → ${side}!`);
        return true;
      }
      case '/rps': {
        const hands = ['✊ ROCK', '✋ PAPER', '✌️ SCISSORS'];
        const choice = argStr.toLowerCase();
        let pick: string;
        if (choice === 'r' || choice === 'rock') {
          pick = hands[0];
        } else if (choice === 'p' || choice === 'paper') {
          pick = hands[1];
        } else if (choice === 's' || choice === 'scissors') {
          pick = hands[2];
        } else {
          pick = hands[Math.floor(Math.random() * hands.length)];
        }
        this.dispatchUserChat(`${nick} threw ${pick}!`);
        return true;
      }
      case '/8ball': {
        if (!argStr) {
          this.showToast('Usage: /8ball <question>');
          return true;
        }
        const ans = EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];
        this.dispatchUserChat(`🎱 Q: ${argStr} → ${ans}`);
        return true;
      }
      case '/pick': {
        const items = (argStr.includes(',') ? argStr.split(',') : argStr.split(/\s+/))
          .map((s) => s.trim())
          .filter(Boolean);
        if (items.length < 2) {
          this.showToast('Usage: /pick option1, option2, ...');
          return true;
        }
        const chosen = items[Math.floor(Math.random() * items.length)];
        this.dispatchUserChat(`🎯 ${nick} picked: ${chosen} (from ${items.join(', ')})`);
        return true;
      }
      case '/shout': {
        if (!argStr) return true;
        this.dispatchUserChat(`📢 **${this.expandInlineEmotes(argStr).toUpperCase()}**`);
        return true;
      }
      case '/me': {
        if (!argStr) return true;
        this.dispatchUserChat(`* ${nick} ${this.expandInlineEmotes(argStr)} *`);
        return true;
      }
      default: {
        const emote = ASCII_EMOTES[cmd];
        if (emote) {
          this.dispatchUserChat(`${this.expandInlineEmotes(argStr)} ${emote}`.trim());
          return true;
        }
        return false;
      }
    }
  }

  private dispatchUserChat(text: string): void {
    const msg = this.engine.sendChatMessage(text, this.replyTo, this.whisperTarget);
    this.pushMessageToMemory(msg);

    this.replyTo = undefined;
    this.engine.sendTyping(false);
    this.updateContextBannerDOM();
    this.scrollToBottom();
  }

  // =========================================================================
  // DOM RENDERING & INCREMENTAL UPDATES
  // =========================================================================
  public render(): void {
    const prevStream = this.root.querySelector('#message-stream') as HTMLElement | null;
    const prevScrollTop = prevStream ? prevStream.scrollTop : null;
    const wasAtBottom = this.isAtBottom;

    this.root.innerHTML = `
      <div class="layout">
        ${this.mobileDrawerOpen ? `<div class="drawer-backdrop" id="drawer-backdrop"></div>` : ''}
        <aside class="sidebar ${this.mobileDrawerOpen ? 'open' : ''}" id="sidebar">
          <div class="sidebar-header">
            <div class="brand" id="brand-logo" title="Reload revchat">
              <span class="status-dot ${this.signalingState.status}" id="sig-dot"></span>
              <span>revchat // p2p</span>
            </div>
            <button class="small mobile-only" id="btn-close-drawer">✕</button>
          </div>

          <!-- Identity Section -->
          <div class="side-section">
            <div class="sec-title">
              <span>Nickname</span>
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
              <span>Follow Peer</span>
            </div>
            <div class="field-row">
              <input type="text" id="input-direct-peer" placeholder="Enter Peer Code" />
              <button id="btn-dial-peer">FOLLOW</button>
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

          <!-- Sidebar Footer Toolbar: Direct Font Size (S/M/L) + Theme + Help -->
          <div class="side-toolbar">
            <div class="size-group">
              <button class="small ${this.fontSizeKey === 's' ? 'primary' : ''}" data-size-key="s" title="Small Font (14px)">S</button>
              <button class="small ${this.fontSizeKey === 'm' ? 'primary' : ''}" data-size-key="m" title="Medium Font (17px)">M</button>
              <button class="small ${this.fontSizeKey === 'l' ? 'primary' : ''}" data-size-key="l" title="Large Font (20px)">L</button>
            </div>
            <div class="tool-group">
              <button class="small" id="btn-theme" title="Toggle Dark/Light Theme">
                ${this.profile.theme === 'dark' ? 'LIGHT' : 'DARK'}
              </button>
              <button class="small" id="btn-help" title="Commands & Help">HELP</button>
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
            </div>
          </header>

          <div id="search-bar-container">
            ${this.renderSearchBarHtml()}
          </div>

          <div class="message-stream" id="message-stream">
            ${this.renderMessagesHtml()}
          </div>

          <button class="jump-bottom-btn" id="btn-jump-bottom" style="display:none;">
            ↓ Jump to latest
          </button>

          <div id="slash-menu-container"></div>

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

    const newStream = this.root.querySelector('#message-stream') as HTMLElement | null;
    if (newStream) {
      if (wasAtBottom) {
        this.scrollToBottom();
      } else if (prevScrollTop !== null) {
        newStream.scrollTop = prevScrollTop;
        this.updateJumpButtonDOM();
      }
    }
  }

  private renderSearchBarHtml(): string {
    if (!this.searchOpen) return '';
    return `
      <div class="search-bar">
        <input type="search" id="input-search" value="${this.escapeAttr(this.searchQuery)}" placeholder="Filter messages by text or author..." />
        <button class="small" id="btn-close-search">CLOSE</button>
      </div>
    `;
  }

  private updateSearchBarDOM(): void {
    const container = this.root.querySelector('#search-bar-container');
    if (!container) return;
    container.innerHTML = this.renderSearchBarHtml();
    if (this.searchOpen) {
      const input = container.querySelector('#input-search') as HTMLInputElement | null;
      input?.addEventListener('input', (e) => {
        this.searchQuery = (e.target as HTMLInputElement).value;
        this.appendOrRefreshMessages();
      });
      container.querySelector('#btn-close-search')?.addEventListener('click', () => {
        this.searchOpen = false;
        if (this.searchQuery) {
          this.searchQuery = '';
          this.appendOrRefreshMessages();
        }
        this.updateSearchBarDOM();
      });
      input?.focus();
    }
  }

  private renderPeersListHtml(): string {
    if (this.peers.length === 0) {
      return `
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--fg-muted);padding:8px 0;">
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
            <li><b>Follow Peer:</b> Enter a friend's Peer Code in <b>FOLLOW</b> to jump into their room.</li>
            <li><b>Commands:</b> <code>/roll</code>, <code>/coin</code>, <code>/rps</code>, <code>/8ball</code>, <code>/pick</code>, <code>/help</code></li>
          </ul>
        </div>
      `;
    }

    return filtered.map((m) => this.renderSingleMessageHtml(m)).join('');
  }

  private renderSingleMessageHtml(m: ChatMessage): string {
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
              data-copy-id="${this.escapeAttr(m.id)}"
              title="Copy message"
            >
              copy
            </button>
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
    }
    const sideCount = this.root.querySelector('#peer-count-side');
    if (sideCount) sideCount.textContent = String(this.peers.length);

    const mobileCount = this.root.querySelector('#mobile-peer-count');
    if (mobileCount) mobileCount.textContent = String(this.peers.length);

    const topBadge = this.root.querySelector('#topbar-peer-badge');
    if (topBadge) {
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

  private appendSingleMessageDOM(msg: ChatMessage, evicted: boolean): void {
    if (this.searchQuery.trim()) {
      this.appendOrRefreshMessages();
      return;
    }
    const stream = this.root.querySelector('#message-stream') as HTMLElement | null;
    if (!stream) return;

    const wasAtBottom =
      stream.scrollHeight - stream.scrollTop - stream.clientHeight < 65;

    stream.querySelector('.empty-state')?.remove();
    if (evicted) {
      stream.querySelector('.msg-row')?.remove();
    }
    stream.insertAdjacentHTML('beforeend', this.renderSingleMessageHtml(msg));

    if (wasAtBottom) {
      this.scrollToBottom();
    } else {
      this.unreadWhileScrolled++;
      this.updateJumpButtonDOM();
    }
  }

  private appendOrRefreshMessages(): void {
    const stream = this.root.querySelector('#message-stream') as HTMLElement | null;
    if (!stream) return;

    const wasAtBottom =
      stream.scrollHeight - stream.scrollTop - stream.clientHeight < 65;
    stream.innerHTML = this.renderMessagesHtml();

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
                  <span>My Peer Code:</span>
                  <code class="code-pill">${this.escapeHtml(this.profile.clientId.toUpperCase())}</code>
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
                  1. <b>Room Code:</b> Join the same Room Code (or scan QR) to form a direct WebRTC mesh.<br/>
                  2. <b>FOLLOW Peer Code:</b> Enter a friend's Peer Code and click FOLLOW to automatically jump into their current room.<br/>
                  3. <b>Zero Persistence:</b> Nothing is saved to disk or storage; closing the tab destroys your session and messages immediately.
                </div>
              </div>
              <div class="step-block">
                <div class="step-title">Slash Commands</div>
                <div style="font-family:var(--font-mono);font-size:12px;display:flex;flex-direction:column;gap:4px;">
                  <div><code>/nick &lt;name&gt;</code> — Change your display nickname</div>
                  <div><code>/room [code]</code> — Switch room (or random room if empty)</div>
                  <div><code>/follow &lt;code&gt;</code> — Follow a peer into their active room</div>
                  <div><code>/size [s|m|l]</code> — Change main panel font size</div>
                  <div><code>/roll [max]</code> — Roll a dice (default 1–100)</div>
                  <div><code>/coin</code> — Flip a coin (HEADS / TAILS)</div>
                  <div><code>/rps [r|p|s]</code> — Throw Rock / Paper / Scissors (or random)</div>
                  <div><code>/8ball &lt;q&gt;</code> — Ask the Magic 8-Ball a question</div>
                  <div><code>/pick &lt;a, b, ...&gt;</code> — Randomly pick one item from any number of options</div>
                  <div><code>/shout &lt;msg&gt;</code> — Send a loud uppercase announcement</div>
                  <div><code>/me &lt;action&gt;</code> — Send an action status message</div>
                  <div><code>/shrug</code> <code>/flip</code> <code>/unflip</code> <code>/lenny</code> <code>/look</code> <code>/gib</code> <code>/sparkle</code> <code>/fight</code> <code>/bear</code> <code>/cry</code> <code>/love</code> <code>/dance</code> — ASCII emotes</div>
                  <div><code>/clear</code> — Clear current chat screen</div>
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
    }
  }

  // =========================================================================
  // EVENT BINDINGS
  // =========================================================================
  private bindEvents(): void {
    // Brand logo reload & Mobile drawer controls
    this.root.querySelector('#brand-logo')?.addEventListener('click', () => {
      window.location.reload();
    });
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

    // Font Size Direct Buttons & Theme
    this.root.querySelectorAll('[data-size-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-size-key') as 's' | 'm' | 'l' | null;
        if (key) {
          this.applyFontSize(key);
        }
      });
    });
    this.root.querySelector('#btn-theme')?.addEventListener('click', (e) => {
      const current = document.documentElement.getAttribute('data-theme');
      this.profile.theme = current === 'dark' ? 'light' : 'dark';
      this.applyTheme();
      const btn = e.currentTarget as HTMLElement | null;
      if (btn) {
        btn.textContent = this.profile.theme === 'dark' ? 'LIGHT' : 'DARK';
      }
    });

    // Nickname
    const saveNick = () => {
      const input = this.root.querySelector('#input-nick') as HTMLInputElement | null;
      const val = sanitizeString(input?.value, MAX_NICKNAME_LENGTH).trim();
      if (val) {
        this.profile.nickname = val;
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

    // Follow Peer (Follows target peer into their room)
    const dialPeer = () => {
      const input = this.root.querySelector('#input-direct-peer') as HTMLInputElement | null;
      const val = input?.value.trim() || '';
      if (!val) return;
      const ok = this.engine.connectToDirectPeer(val, true);
      if (ok) {
        if (input) input.value = '';
        this.mobileDrawerOpen = false;
        this.render();
        this.showToast(`Following ${val} into their room...`);
      } else {
        this.showToast('Could not follow peer (check code)');
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
      if (this.mobileDrawerOpen) {
        this.mobileDrawerOpen = false;
        this.render();
      }
      this.activeModal = 'help';
      this.renderModal();
    });

    // Search
    this.root.querySelector('#btn-toggle-search')?.addEventListener('click', () => {
      this.searchOpen = !this.searchOpen;
      if (!this.searchOpen && this.searchQuery) {
        this.searchQuery = '';
        this.appendOrRefreshMessages();
      }
      this.updateSearchBarDOM();
    });
    this.updateSearchBarDOM();

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
      this.slashMenuDismissed = false;
      this.slashMenuIndex = 0;
      this.updateSlashMenuDOM(textarea.value);

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
      const matches = this.getMatchingSlashCommands(textarea.value);
      if (matches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.slashMenuIndex = (this.slashMenuIndex + 1) % matches.length;
          this.updateSlashMenuDOM(textarea.value);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.slashMenuIndex = (this.slashMenuIndex - 1 + matches.length) % matches.length;
          this.updateSlashMenuDOM(textarea.value);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.slashMenuDismissed = true;
          this.updateSlashMenuDOM(textarea.value);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const chosen = matches[this.slashMenuIndex] || matches[0];
          this.applySlashCommandSelection(chosen, textarea, autoResize);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          const chosen = matches[this.slashMenuIndex] || matches[0];
          const trimmed = textarea.value.trim().toLowerCase();
          const isMidSentence = !textarea.value.startsWith('/') || textarea.value.includes(' ');
          if (isMidSentence || trimmed !== chosen.cmd || chosen.needsArgs) {
            e.preventDefault();
            this.applySlashCommandSelection(chosen, textarea, autoResize);
            return;
          }
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.trim()) {
          const val = textarea.value;
          textarea.value = '';
          autoResize();
          this.updateSlashMenuDOM('');
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
        this.updateSlashMenuDOM('');
        this.handleSendMessage(val);
        textarea.focus();
      }
    });

    this.bindPeerItemEvents();
    this.bindMessageStreamEvents();
    this.updateContextBannerDOM();
  }

  private getMatchingSlashCommands(rawInput: string): SlashCommandDef[] {
    if (this.slashMenuDismissed) return [];
    if (rawInput.includes('\n')) return [];

    if (rawInput.startsWith('/') && !rawInput.includes(' ')) {
      const prefix = rawInput.toLowerCase();
      return SLASH_COMMANDS.filter((item) => item.cmd.startsWith(prefix));
    }

    const match = rawInput.match(/(?:^|\s)(\/[a-z0-9]*)$/i);
    if (!match) return [];
    const token = match[1].toLowerCase();
    return SLASH_COMMANDS.filter(
      (item) => Boolean(ASCII_EMOTES[item.cmd]) && item.cmd.startsWith(token)
    );
  }

  private applySlashCommandSelection(
    item: SlashCommandDef,
    textarea: HTMLTextAreaElement,
    autoResize: () => void
  ): void {
    const val = textarea.value;
    if (val.startsWith('/') && !val.includes(' ')) {
      textarea.value = `${item.cmd} `;
    } else {
      const emote = ASCII_EMOTES[item.cmd] || item.cmd;
      textarea.value = val.replace(/(\/[a-z0-9]*)$/i, `${emote} `);
    }
    autoResize();
    this.updateSlashMenuDOM(textarea.value);
    textarea.focus();
  }

  private updateSlashMenuDOM(rawInput: string): void {
    const container = this.root.querySelector('#slash-menu-container') as HTMLElement | null;
    if (!container) return;

    const matches = this.getMatchingSlashCommands(rawInput);
    if (matches.length === 0) {
      container.innerHTML = '';
      return;
    }

    if (this.slashMenuIndex >= matches.length) {
      this.slashMenuIndex = 0;
    }

    container.innerHTML = `
      <div class="slash-menu" id="slash-menu">
        <div class="slash-menu-header">
          <span>Slash Commands (${matches.length})</span>
          <span>↑↓ Navigate • Tab/Enter Select</span>
        </div>
        ${matches
          .map(
            (item, idx) => `
          <div class="slash-item ${idx === this.slashMenuIndex ? 'active' : ''}" data-slash-idx="${idx}">
            <span class="slash-cmd">${this.escapeHtml(item.usage)}</span>
            <span class="slash-desc">${this.escapeHtml(item.desc)}</span>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    const activeEl = container.querySelector('.slash-item.active') as HTMLElement | null;
    activeEl?.scrollIntoView({ block: 'nearest' });

    const textarea = this.root.querySelector('#composer-input') as HTMLTextAreaElement | null;
    container.querySelectorAll('[data-slash-idx]').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = Number(el.getAttribute('data-slash-idx') || 0);
        const chosen = matches[idx];
        if (chosen && textarea) {
          this.applySlashCommandSelection(chosen, textarea, () => {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(120, textarea.scrollHeight)}px`;
          });
        }
      });
    });
  }

  private bindPeerItemEvents(): void {
    const peerContainer = this.root.querySelector('#peer-list-container');
    peerContainer?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest('[data-whisper-id]');
      if (!btn) return;
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
  }

  private bindMessageStreamEvents(): void {
    const stream = this.root.querySelector('#message-stream');
    stream?.addEventListener('click', (e) => {
      const targetEl = e.target as HTMLElement | null;
      if (!targetEl) return;

      const copyBtn = targetEl.closest('[data-copy-id]');
      if (copyBtn) {
        const id = copyBtn.getAttribute('data-copy-id') || '';
        const target = this.messages.find((m) => m.id === id);
        if (target) {
          navigator.clipboard?.writeText(target.text);
          this.showToast('Message copied!');
        }
        return;
      }

      const replyBtn = targetEl.closest('[data-reply-id]');
      if (replyBtn) {
        const id = replyBtn.getAttribute('data-reply-id') || '';
        const senderName = replyBtn.getAttribute('data-reply-sender') || '';
        const text = replyBtn.getAttribute('data-reply-text') || '';
        this.replyTo = { id, senderName, text };
        this.updateContextBannerDOM();
        (this.root.querySelector('#composer-input') as HTMLTextAreaElement | null)?.focus();
      }
    });
  }

  // =========================================================================
  // FORMATTING HELPERS
  // =========================================================================
  private formatMessageBody(raw: string): string {
    let safe = this.escapeHtml(raw);
    safe = safe.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
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
