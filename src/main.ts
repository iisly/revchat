import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STEP,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  SlashCommandDef,
  clampFontSize,
  expandInlineTokens,
  getMatchingMentions,
  getMatchingSlashCommands,
  parseFontSizeInput,
  runCoinFlip,
  runDiceRoll,
  runEightBall,
  runPick,
  runRps,
} from './commands';
import { escapeAttr, escapeHtml } from './markdown';
import {
  BlobUrlRegistry,
  MAX_MEDIA_BYTES,
  classifyFilePreview,
  classifyMime,
  compressImageIfNeeded,
  extractClipboardFiles,
  formatFileSize,
  inferMimeFromFilename,
  readBlobPreviewText,
} from './media';
import { NotificationManager } from './notifications';
import { P2PEngine } from './p2p-engine';
import { generateQrSvg } from './qrcode';
import {
  MAX_NICKNAME_LENGTH,
  isAllowedReaction,
  sanitizeFilename,
  sanitizeString,
} from './security';
import {
  buildRoomUrl,
  copyTextToClipboard,
  createSessionProfile,
  generateRoomCode,
  generateUUID,
  normalizeRoomId,
  parseRoomFromUrl,
  saveSessionProfile,
} from './storage';
import {
  ChatMessage,
  PeerInfo,
  RemoteCallStream,
  SignalingState,
  UserProfile,
} from './types';
import { CallDockController } from './ui/call-bar';
import { ComposerController } from './ui/composer';
import {
  iconArrowDown,
  iconClose,
  iconHelp,
  iconMenu,
  iconMoon,
  iconSearch,
  iconShare,
  iconSun,
  iconVolumeOff,
  iconVolumeOn,
} from './ui/icons';
import {
  MessageRenderContext,
  renderMessagesListHtml,
  renderReactionPickerHtml,
  renderSingleMessageHtml,
  shouldGroupMessages,
} from './ui/messages';
import { ActiveModalType, FilePreviewState, renderModalDOM } from './ui/modals';

const MAX_MEMORY_MESSAGES = 1000;

class RevChatApp {
  private root: HTMLElement;
  private profile: UserProfile;
  private roomId: string;
  private engine!: P2PEngine;
  private notifications: NotificationManager;
  private blobs = new BlobUrlRegistry();
  private composer!: ComposerController;
  private callDock = new CallDockController();

  private signalingState: SignalingState;
  private peers: PeerInfo[] = [];
  private messages: ChatMessage[] = [];
  private messageMap = new Map<string, ChatMessage>();
  private typingPeers: { peerId: string; nickname: string }[] = [];

  // Call state
  private localCallStream: MediaStream | null = null;
  private localVideoEnabled = false;
  private localCallMuted = false;
  private isScreenShare = false;
  private remoteCallStreams: RemoteCallStream[] = [];

  // UI state
  private mobileDrawerOpen = false;
  private activeModal: ActiveModalType = 'none';
  private inviteQrSvg = '';
  private lightboxUrl?: string;
  private lightboxName?: string;
  private filePreview?: FilePreviewState;
  private searchOpen = false;
  private searchQuery = '';
  private replyTo: ChatMessage['replyTo'] | undefined = undefined;
  private whisperTarget: { peerId: string; nickname: string } | undefined = undefined;
  private isAtBottom = true;
  private unreadWhileScrolled = 0;
  private slashMenuIndex = 0;
  private slashMenuDismissed = false;
  private mentionMenuIndex = 0;
  private mentionMenuDismissed = false;
  private fontSizePx: number;

  // Timers
  private lastTypingSentAt = 0;
  private stopTypingTimer: number | null = null;
  private toastTimer: number | null = null;
  private lastPeersListHtml = '';

  constructor(root: HTMLElement) {
    this.root = root;
    this.profile = createSessionProfile();
    this.fontSizePx = clampFontSize(this.profile.fontSize || DEFAULT_FONT_SIZE);
    this.applyTheme(false);
    this.setFontSize(this.fontSizePx, false);

    this.roomId = parseRoomFromUrl(window.location.href);
    this.syncUrlWithRoom(this.roomId);

    this.notifications = new NotificationManager(this.roomId, this.profile.soundMuted);
    this.composer = new ComposerController(this.root, this.roomId, {
      onTypingInput: (val) => this.handleComposerTypingInput(val),
      onStartCall: (video) => void this.startCallFlow(video),
      onSendVoice: (blob, mime, dur) => void this.handleSendVoiceNote(blob, mime, dur),
      onRunQuickCommand: (cmdLine) => this.handleSendMessage(cmdLine),
      onPreviewStagedImage: (url, name) => {
        this.lightboxUrl = url;
        this.lightboxName = name;
        this.activeModal = 'lightbox';
        this.renderModal();
      },
      onToast: (msg) => this.showToast(msg),
      isInCall: () => Boolean(this.localCallStream),
    });

    this.signalingState = {
      status: 'initializing',
    };

    this.setupVisualViewportFix();
    this.setupLifecycleCleanup();
    this.setupGlobalKeyHandlers();
    this.render();
    this.initEngine();
  }

  private setupLifecycleCleanup(): void {
    const cleanup = () => {
      this.composer.clearStagedFiles();
      this.callDock.destroy();
      this.notifications.destroy();
      this.blobs.revokeAll();
      if (this.engine) {
        this.engine.destroy();
      }
    };
    window.addEventListener('pagehide', cleanup);
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) {
        window.location.reload();
      }
    });
    window.addEventListener('hashchange', () => {
      const nextRoomId = parseRoomFromUrl(window.location.href);
      if (nextRoomId !== this.roomId) {
        void this.switchRoom(nextRoomId);
      }
    });
  }

  private setupGlobalKeyHandlers(): void {
    document.addEventListener('paste', (e) => {
      if (this.activeModal !== 'none') return;
      const target = e.target as HTMLElement | null;
      if (target?.id === 'composer-input') return;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      const files = extractClipboardFiles(e.clipboardData);
      if (files.length > 0) {
        e.preventDefault();
        this.composer.stageFiles(files);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (
        e.key === '/' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.isComposing &&
        this.activeModal === 'none'
      ) {
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName;
        if (
          tag !== 'INPUT' &&
          tag !== 'TEXTAREA' &&
          tag !== 'SELECT' &&
          !active?.isContentEditable
        ) {
          const ta = this.composer.getTextarea();
          if (ta) {
            e.preventDefault();
            if (this.mobileDrawerOpen) this.setMobileDrawerOpen(false);
            ta.focus({ preventScroll: true });
            const end = ta.value.length;
            ta.setSelectionRange(end, end);
            return;
          }
        }
      }

      if (e.key === 'Escape') {
        if (this.activeModal !== 'none') {
          this.activeModal = 'none';
          this.renderModal();
          return;
        }
        if (this.callDock.exitTheaterIfActive()) {
          return;
        }
        if (this.mobileDrawerOpen) {
          this.setMobileDrawerOpen(false);
          return;
        }
        if (this.composer.hasOpenPopover()) {
          this.composer.closePopovers();
          return;
        }
        const openPickers = this.root.querySelectorAll('.reaction-picker-slot:not(:empty)');
        const openToolbars = this.root.querySelectorAll('.msg-row.toolbar-open');
        if (openPickers.length > 0 || openToolbars.length > 0) {
          openPickers.forEach((slot) => {
            slot.innerHTML = '';
          });
          openToolbars.forEach((row) => row.classList.remove('toolbar-open'));
          return;
        }
        if (this.searchOpen) {
          this.searchOpen = false;
          this.searchQuery = '';
          this.root.querySelector('#btn-toggle-search')?.classList.remove('active');
          this.updateSearchBarDOM();
          this.appendOrRefreshMessages();
        }
      }
    });

    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (!target.closest('.msg-row')) {
        this.root.querySelectorAll('.msg-row.toolbar-open').forEach((row) => {
          row.classList.remove('toolbar-open');
        });
      }

      if (!this.composer.hasOpenPopover()) return;
      const slot = this.root.querySelector('#composer-popover-slot');
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (
        (slot && path.includes(slot)) ||
        target.closest('#composer-popover-slot') ||
        target.closest('#btn-plus-drawer') ||
        target.closest('#btn-emote-picker')
      ) {
        return;
      }
      this.composer.closeNonVoicePopovers();
    });
  }

  private syncUrlWithRoom(roomId: string): void {
    try {
      const next = buildRoomUrl(window.location.href, roomId);
      window.history.replaceState({}, '', next);
    } catch {
      // ignore
    }
  }

  private getInviteUrl(): string {
    return buildRoomUrl(window.location.href, this.roomId);
  }

  private setupVisualViewportFix(): void {
    const updateHeight = () => {
      const vv = window.visualViewport;
      const h = Math.round(vv ? vv.height : window.innerHeight);
      document.documentElement.style.setProperty('--app-height', `${h}px`);
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }
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

  private applyTheme(save = true): void {
    if (this.profile.theme === 'auto') {
      this.profile.theme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    document.documentElement.setAttribute('data-theme', this.profile.theme);
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute('content', this.profile.theme === 'dark' ? '#181818' : '#f5f5f5');
    }
    if (save) saveSessionProfile(this.profile);
  }

  private syncThemeButtonDOM(): void {
    const themeBtn = this.root.querySelector('#btn-theme');
    if (!themeBtn) return;
    const isDark = this.profile.theme === 'dark';
    themeBtn.innerHTML = isDark ? iconSun(16) : iconMoon(16);
    themeBtn.setAttribute(
      'title',
      isDark ? 'Switch to Light Theme' : 'Switch to Dark Theme'
    );
  }

  private setTheme(target?: 'dark' | 'light', showBanner = false): void {
    const current =
      document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = target || (current === 'dark' ? 'light' : 'dark');
    this.profile.theme = next;
    this.applyTheme(true);
    this.engine?.updateProfile(this.profile);
    this.syncThemeButtonDOM();
    if (showBanner) {
      this.showToast(`Theme switched to ${next.toUpperCase()}`);
    }
  }

  private setFontSize(px: number, showBanner = true): void {
    const clamped = clampFontSize(px);
    this.fontSizePx = clamped;
    this.profile.fontSize = clamped;
    saveSessionProfile(this.profile);

    document.documentElement.style.setProperty('--msg-font-size', `${clamped}px`);
    const readout = this.root.querySelector('#btn-size-reset');
    if (readout) readout.textContent = `${clamped}px`;
    const decBtn = this.root.querySelector('#btn-size-dec') as HTMLButtonElement | null;
    if (decBtn) decBtn.disabled = clamped <= MIN_FONT_SIZE;
    const incBtn = this.root.querySelector('#btn-size-inc') as HTMLButtonElement | null;
    if (incBtn) incBtn.disabled = clamped >= MAX_FONT_SIZE;

    if (showBanner) {
      this.showToast(`Text size: ${clamped}px`);
    }
  }

  private setNickname(raw: string): boolean {
    const val = sanitizeString(raw, MAX_NICKNAME_LENGTH).trim();
    if (!val) return false;
    if (val === this.profile.nickname) {
      const nickInput = this.root.querySelector('#input-nick') as HTMLInputElement | null;
      if (nickInput) nickInput.value = val;
      return true;
    }
    this.profile.nickname = val;
    saveSessionProfile(this.profile);
    this.engine?.updateProfile(this.profile);
    const nickInput = this.root.querySelector('#input-nick') as HTMLInputElement | null;
    if (nickInput) nickInput.value = val;
    this.updateCallDockDOM();
    this.showToast(`Nickname: ${val}`);
    return true;
  }

  private getMessageRenderContext(): MessageRenderContext {
    return {
      myPeerId: this.engine ? this.engine.getMyPeerId() : `revchat-p-${this.profile.clientId}`,
      myNickname: this.profile.nickname,
      myClientId: this.profile.clientId,
      roomId: this.roomId,
      searchQuery: this.searchQuery,
    };
  }

  private pushMessageToMemory(msg: ChatMessage, notifyIfExternal = false): boolean {
    if (this.messageMap.has(msg.id)) return false;
    this.messageMap.set(msg.id, msg);
    let evicted = false;
    this.messages.push(msg);
    if (this.messages.length > MAX_MEMORY_MESSAGES) {
      const removed = this.messages.shift();
      if (removed) {
        if (removed.attachment?.url) {
          this.blobs.revoke(removed.attachment.url);
        }
        this.messageMap.delete(removed.id);
        evicted = true;
      }
    }
    this.appendSingleMessageDOM(msg, evicted);

    if (notifyIfExternal && !msg.system) {
      this.notifications.onIncomingMessage();
    }
    return true;
  }

  private initEngine(): void {
    this.engine = new P2PEngine(this.profile, this.roomId, {
      onSignalingChange: (state) => {
        this.signalingState = state;
        this.updateStatusDOM();
      },
      onPeersChange: (peers) => {
        this.peers = peers;
        if (this.whisperTarget) {
          const activePeer = peers.find((p) => p.peerId === this.whisperTarget!.peerId);
          if (!activePeer) {
            const prevName = this.whisperTarget.nickname;
            this.whisperTarget = undefined;
            this.updateContextBannerDOM();
            this.showToast(`DM closed: ${prevName} left the room.`);
          } else if (activePeer.nickname !== this.whisperTarget.nickname) {
            this.whisperTarget.nickname = activePeer.nickname;
            this.updateContextBannerDOM();
          }
        }
        this.updatePeersDOM();
        this.updateCallDockDOM();
      },
      onChatMessage: (msg) => {
        this.pushMessageToMemory(msg, true);
      },
      onMessageAck: (messageId, ackPeerId) => {
        const target = this.messageMap.get(messageId);
        if (target && !target.ackedBy.includes(ackPeerId)) {
          target.ackedBy.push(ackPeerId);
          target.deliveryState = 'delivered';
          const completedSending = target.attachment?.status === 'sending';
          if (completedSending && target.attachment) {
            target.attachment.status = 'ready';
            target.attachment.progress = 100;
          }
          const ackEl = this.root.querySelector(`[data-ack-id="${messageId}"]`);
          if (ackEl && !completedSending) {
            ackEl.textContent = `✓✓ ${target.ackedBy.length}`;
          } else {
            this.rerenderSingleMessageRow(messageId);
          }
        }
      },
      onMessageFailed: (messageId) => {
        const target = this.messageMap.get(messageId);
        if (target && target.ackedBy.length === 0) {
          target.deliveryState = 'failed';
          this.rerenderSingleMessageRow(messageId);
        }
      },
      onMessageReaction: (messageId, emoji, actorId) => {
        this.applyReactionLocally(messageId, emoji, actorId);
      },
      onMessageDeleted: (messageId, senderId) => {
        const idx = this.messages.findIndex((m) => m.id === messageId);
        const target = idx >= 0 ? this.messages[idx] : this.messageMap.get(messageId);
        if (!target || target.senderId !== senderId) return;
        target.deleted = true;
        target.text = '';
        if (target.attachment?.url) {
          this.blobs.revoke(target.attachment.url);
        }
        target.attachment = undefined;
        this.rerenderSingleMessageRow(messageId);
        if (idx >= 0 && this.messages[idx + 1]) {
          this.rerenderSingleMessageRow(this.messages[idx + 1].id);
        }
      },
      onMediaProgress: (transferId, pct, phase) => {
        const msg = this.messageMap.get(transferId);
        if (!msg?.attachment) return;
        if (phase === 'sending' && msg.attachment.status === 'ready') return;
        msg.attachment.progress = pct;
        if (pct >= 100 && msg.attachment.status === 'sending') {
          msg.attachment.status = 'ready';
          msg.deliveryState = msg.ackedBy.length > 0 ? 'delivered' : 'sent';
          this.rerenderSingleMessageRow(transferId);
          return;
        }
        const row = this.root.querySelector(`[data-transfer-id="${transferId}"]`);
        if (row) {
          const fill = row.querySelector('.msg-prog-fill') as HTMLElement | null;
          const pctEl = row.querySelector('.prog-pct');
          if (fill) fill.style.width = `${pct}%`;
          if (pctEl) pctEl.textContent = `${pct}%`;
        }
      },
      onMediaReceived: (transferId, blob, mimeType) => {
        const msg = this.messageMap.get(transferId);
        if (!msg?.attachment) return;
        msg.attachment.url = this.blobs.create(blob);
        msg.attachment.mimeType = mimeType;
        msg.attachment.status = 'ready';
        msg.attachment.progress = 100;
        this.rerenderSingleMessageRow(transferId);
      },
      onMediaCanceled: (transferId) => {
        const msg = this.messageMap.get(transferId);
        if (!msg?.attachment) return;
        msg.attachment.status = 'canceled';
        this.rerenderSingleMessageRow(transferId);
      },
      onMediaFailed: (transferId) => {
        const msg = this.messageMap.get(transferId);
        if (!msg?.attachment) return;
        if (msg.ackedBy.length > 0) {
          msg.attachment.status = 'ready';
          msg.attachment.progress = 100;
          msg.deliveryState = 'delivered';
        } else if (msg.attachment.status === 'sending') {
          msg.attachment.status = 'error';
          msg.deliveryState = 'failed';
        }
        this.rerenderSingleMessageRow(transferId);
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
        this.pushMessageToMemory(sysMsg, false);
      },
      onCallStreamsChange: (streams) => {
        this.remoteCallStreams = streams;
        this.updateCallDockDOM();
      },
      onLocalStreamUpdated: (stream, videoEnabled, muted, isScreenShare) => {
        this.localCallStream = stream;
        this.localVideoEnabled = videoEnabled;
        this.localCallMuted = muted;
        this.isScreenShare = isScreenShare;
        this.updateCallDockDOM();
      },
    });

    void this.engine.start();
  }

  private setMobileDrawerOpen(open: boolean): void {
    this.mobileDrawerOpen = open;
    const sidebar = this.root.querySelector('#sidebar');
    sidebar?.classList.toggle('open', open);
    const backdrop = this.root.querySelector('#drawer-backdrop') as HTMLElement | null;
    if (backdrop) {
      backdrop.style.display = open ? 'block' : 'none';
    }
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

  private async switchRoom(targetRoom: string): Promise<void> {
    const normalized = normalizeRoomId(targetRoom);
    if (normalized === this.roomId) {
      this.setMobileDrawerOpen(false);
      return;
    }
    this.callDock.reset();
    this.composer.clearStagedFiles();
    this.blobs.revokeAll();
    this.roomId = normalized;
    this.syncUrlWithRoom(this.roomId);
    this.composer.setRoomId(this.roomId);
    this.notifications.updateContext(this.roomId, this.profile.soundMuted);
    this.replyTo = undefined;
    this.whisperTarget = undefined;
    this.searchOpen = false;
    this.searchQuery = '';
    this.mobileDrawerOpen = false;
    this.messages = [];
    this.messageMap.clear();
    this.localCallStream = null;
    this.remoteCallStreams = [];
    await this.engine.switchRoom(this.roomId);
    this.render();
    this.scrollToBottom();
  }

  private async switchToRandomRoom(): Promise<void> {
    const code = generateRoomCode();
    await this.switchRoom(code);
  }

  private toggleSoundMute(): void {
    this.profile.soundMuted = !this.profile.soundMuted;
    saveSessionProfile(this.profile);
    this.notifications.updateContext(this.roomId, this.profile.soundMuted);
    const btn = this.root.querySelector('#btn-mute-sound');
    if (btn) {
      btn.innerHTML = this.profile.soundMuted ? iconVolumeOff(15) : iconVolumeOn(15);
      btn.classList.toggle('muted', this.profile.soundMuted);
      const label = this.profile.soundMuted
        ? 'Sound Muted (click to unmute)'
        : 'Sound On (click to mute)';
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label);
    }
    this.showToast(this.profile.soundMuted ? 'Sound muted' : 'Sound enabled');
  }

  private handleSendMessage(rawInput: string): void {
    this.notifications.unlockAudio();
    const text = rawInput.trim();
    if (!text) return;

    if (this.composer.hasOpenPopover()) {
      this.composer.closePopovers();
    }

    if (text.startsWith('/') && this.executeSlashCommand(text)) {
      return;
    }

    this.dispatchUserChat(expandInlineTokens(text, this.profile.nickname));
  }

  private executeSlashCommand(text: string): boolean {
    const parts = text.split(/\s+/);
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
        this.blobs.revokeAll();
        this.messages = [];
        this.messageMap.clear();
        this.appendOrRefreshMessages();
        this.showToast('Cleared chat view');
        return true;
      }
      case '/nick': {
        if (!this.setNickname(argStr)) {
          this.showToast('Usage: /nick <name>');
        }
        return true;
      }
      case '/room': {
        if (argStr) {
          void this.switchRoom(argStr);
        } else {
          void this.switchToRandomRoom();
        }
        return true;
      }
      case '/mute': {
        this.toggleSoundMute();
        return true;
      }
      case '/size': {
        const res = parseFontSizeInput(argStr, this.fontSizePx);
        if (res.px !== undefined) {
          this.setFontSize(res.px, true);
        } else if (res.error) {
          this.showToast(res.error);
        }
        return true;
      }
      case '/coin': {
        const res = runCoinFlip(nick, argStr);
        if (res.error) this.showToast(res.error);
        else if (res.text) this.dispatchUserChat(res.text);
        return true;
      }
      case '/roll': {
        const res = runDiceRoll(nick, argStr);
        if (res.error) this.showToast(res.error);
        else if (res.text) this.dispatchUserChat(res.text);
        return true;
      }
      case '/pick': {
        const res = runPick(nick, argStr);
        if (res.error) this.showToast(res.error);
        else if (res.text) this.dispatchUserChat(res.text);
        return true;
      }
      case '/rps': {
        const res = runRps(nick, argStr);
        if (res.error) this.showToast(res.error);
        else if (res.text) this.dispatchUserChat(res.text);
        return true;
      }
      case '/8ball': {
        const res = runEightBall(nick, argStr);
        if (res.error) this.showToast(res.error);
        else if (res.text) this.dispatchUserChat(res.text);
        return true;
      }
      case '/theme': {
        const arg = argStr.toLowerCase();
        const target = arg === 'dark' || arg === 'light' ? arg : undefined;
        this.setTheme(target, true);
        return true;
      }
      default:
        return false;
    }
  }

  private dispatchUserChat(text: string): void {
    const reply = this.replyTo;
    const whisper = this.whisperTarget;
    this.replyTo = undefined;
    this.engine.sendTyping(false);
    this.updateContextBannerDOM();

    void this.engine.sendChatMessage(text, reply, whisper).then((msg) => {
      this.pushMessageToMemory(msg, false);
      this.scrollToBottom();
    });
  }

  private async handleSelectedFiles(fileList: FileList | File[]): Promise<void> {
    this.notifications.unlockAudio();
    const files = Array.from(fileList);
    if (files.length === 0) return;

    for (const file of files) {
      if (file.size === 0) {
        this.showToast(`Skipped empty file: ${file.name}`);
        continue;
      }
      let blobToSend: Blob = file;
      let mime = file.type || inferMimeFromFilename(file.name);
      let kind = classifyMime(mime, file.name);

      if (kind === 'image') {
        const compressed = await compressImageIfNeeded(file);
        blobToSend = compressed.blob;
        mime = compressed.mimeType;
        if (!compressed.canRenderAsImage) {
          kind = 'file';
        }
      }

      const stableBytes = await blobToSend.arrayBuffer();
      const stableBlob = new Blob([stableBytes], { type: mime });

      if (stableBlob.size > MAX_MEDIA_BYTES) {
        this.showToast(`${file.name} exceeds 25 MB limit.`);
        continue;
      }

      try {
        await this.engine.sendMediaAttachment(
          stableBlob,
          {
            kind,
            name: sanitizeFilename(file.name),
            mimeType: mime,
          },
          this.replyTo,
          this.whisperTarget,
          (msg) => {
            if (msg.attachment) {
              msg.attachment.url = this.blobs.create(stableBlob);
            }
            this.replyTo = undefined;
            this.updateContextBannerDOM();
            this.pushMessageToMemory(msg, false);
            this.scrollToBottom();
          }
        );
      } catch (err: any) {
        this.showToast(err?.message || `Failed to send ${file.name}`);
      }
    }
  }

  private async handleSendVoiceNote(
    blob: Blob,
    mimeType: string,
    durationSec: number
  ): Promise<void> {
    this.notifications.unlockAudio();
    const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const name = `voice-${durationSec}s.${ext}`;
    try {
      const stableBlob = new Blob([await blob.arrayBuffer()], { type: mimeType });
      await this.engine.sendMediaAttachment(
        stableBlob,
        { kind: 'audio', name, mimeType },
        this.replyTo,
        this.whisperTarget,
        (msg) => {
          if (msg.attachment) {
            msg.attachment.url = this.blobs.create(stableBlob);
          }
          this.replyTo = undefined;
          this.updateContextBannerDOM();
          this.pushMessageToMemory(msg, false);
          this.scrollToBottom();
        }
      );
    } catch (err: any) {
      this.showToast(err?.message || 'Failed to send voice note');
    }
  }

  private async startCallFlow(video: boolean): Promise<void> {
    this.notifications.unlockAudio();
    this.composer.closePopovers();
    if (this.localCallStream) {
      if (video && !this.localVideoEnabled) {
        try {
          await this.engine.toggleVideo();
          this.showToast('Camera enabled');
        } catch (err: any) {
          this.showToast(err?.message || 'Could not enable camera.');
        }
      } else {
        this.showToast('Already in call — use the call bar controls.');
      }
      return;
    }
    try {
      await this.engine.startCall({ video });
      this.showToast(video ? 'Video call started' : 'Voice call started');
    } catch (err: any) {
      this.showToast(err?.message || 'Could not access microphone/camera.');
    }
  }

  private async toggleScreenShareFlow(): Promise<void> {
    try {
      const active = await this.engine.toggleScreenShare();
      this.showToast(active ? 'Screen sharing started' : 'Screen sharing stopped');
    } catch (err: any) {
      this.showToast(err?.message || 'Screen sharing canceled.');
    }
  }

  // =========================================================================
  // DOM RENDERING & INCREMENTAL UPDATES
  // =========================================================================
  public render(): void {
    this.lastPeersListHtml = '';
    const prevStream = this.root.querySelector('#message-stream') as HTMLElement | null;
    const prevScrollTop = prevStream ? prevStream.scrollTop : null;
    const wasAtBottom = this.isAtBottom;

    this.root.innerHTML = `
      <div class="layout">
        <div class="drawer-backdrop" id="drawer-backdrop" style="display:${this.mobileDrawerOpen ? 'block' : 'none'};"></div>
        <aside class="sidebar ${this.mobileDrawerOpen ? 'open' : ''}" id="sidebar">
          <div class="sidebar-header">
            <a href="./" class="brand" id="brand-logo" title="revchat">
              <img src="./favicon.svg" class="brand-logo" width="22" height="22" alt="" />
              <span class="brand-name">revchat</span>
            </a>
            <div class="sidebar-header-right">
              <span class="sig-status" title="Network status">
                <span class="status-dot ${this.signalingState.status}" id="sig-dot"></span>
                <span id="sig-label">${this.getSignalingBadgeText()}</span>
              </span>
              <button type="button" class="small icon-btn mobile-only" id="btn-close-drawer" title="Close Menu" aria-label="Close menu">${iconClose(15)}</button>
            </div>
          </div>

          <!-- Nickname Section -->
          <div class="side-section">
            <div class="sec-title">
              <span>Nickname</span>
            </div>
            <div class="field-row">
              <input type="text" id="input-nick" value="${escapeAttr(this.profile.nickname)}" maxlength="24" placeholder="Nickname" />
              <button type="button" id="btn-save-nick">SET</button>
            </div>
          </div>

          <!-- Room Section -->
          <div class="side-section">
            <div class="sec-title">
              <span>Room</span>
              <span class="tool-group">
                <button type="button" class="small" id="btn-lobby-room" ${this.roomId === 'LOBBY' ? 'disabled' : ''}>LOBBY</button>
                <button type="button" class="small" id="btn-new-room">RANDOM</button>
              </span>
            </div>
            <div class="field-row">
              <input type="text" id="input-room" value="${escapeAttr(this.roomId)}" maxlength="32" placeholder="Room Code" />
              <button type="button" class="primary" id="btn-join-room">JOIN</button>
            </div>
          </div>

          <!-- Room Members List -->
          <div class="side-section side-members">
            <div class="sec-title">
              <span>Members (<span id="peer-count-side">${this.peers.length}</span>)</span>
            </div>
            <div class="peer-list" id="peer-list-container">
              ${this.renderPeersListHtml()}
            </div>
          </div>

          <!-- Sidebar Footer Toolbar -->
          <div class="side-toolbar">
            <div class="size-group" role="group" aria-label="Chat text size">
              <button type="button" class="small size-step-btn" id="btn-size-dec" title="Decrease text size" aria-label="Decrease text size" ${this.fontSizePx <= MIN_FONT_SIZE ? 'disabled' : ''}>-</button>
              <button type="button" class="small size-readout" id="btn-size-reset" title="Reset text size (${DEFAULT_FONT_SIZE}px)" aria-label="Reset text size">${this.fontSizePx}px</button>
              <button type="button" class="small size-step-btn" id="btn-size-inc" title="Increase text size" aria-label="Increase text size" ${this.fontSizePx >= MAX_FONT_SIZE ? 'disabled' : ''}>+</button>
            </div>
            <div class="tool-group">
              <button
                type="button"
                class="small icon-btn"
                id="btn-theme"
                title="${this.profile.theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}"
                aria-label="Toggle theme"
              >${this.profile.theme === 'dark' ? iconSun(16) : iconMoon(16)}</button>
              <button type="button" class="small icon-btn" id="btn-help" title="Commands & Help" aria-label="Help">${iconHelp(16)}</button>
            </div>
          </div>
        </aside>

        <!-- Main Chat Area -->
        <main class="chat-pane" id="chat-pane">
          <header class="chat-topbar">
            <div class="topbar-left">
              <button type="button" class="small icon-btn mobile-only" id="btn-open-drawer" title="Open Menu" aria-label="Open menu">${iconMenu(15)}</button>
              <span class="room-badge" id="topbar-room-title">#${escapeHtml(this.roomId)}</span>
              <span class="badge ${this.peers.length > 0 ? 'ok' : ''}" id="topbar-peer-badge">${this.peers.length} online</span>
            </div>
            <div class="topbar-actions">
              <button type="button" class="small primary icon-btn" id="btn-topbar-invite" title="Invite (QR Code & Link)" aria-label="Invite">${iconShare(15)}</button>
              <button
                type="button"
                class="small icon-btn ${this.profile.soundMuted ? 'muted' : ''}"
                id="btn-mute-sound"
                title="${this.profile.soundMuted ? 'Sound Muted (click to unmute)' : 'Sound On (click to mute)'}"
                aria-label="${this.profile.soundMuted ? 'Sound Muted (click to unmute)' : 'Sound On (click to mute)'}"
              >${this.profile.soundMuted ? iconVolumeOff(15) : iconVolumeOn(15)}</button>
              <button
                type="button"
                class="small icon-btn ${this.searchOpen ? 'active' : ''}"
                id="btn-toggle-search"
                title="Search Messages"
                aria-label="Search messages"
              >${iconSearch(15)}</button>
            </div>
          </header>

          <div id="call-dock-container"></div>
          <div id="search-bar-container">${this.renderSearchBarHtml()}</div>

          <div class="message-stream" id="message-stream">
            ${renderMessagesListHtml(this.messages, this.getMessageRenderContext())}
          </div>

          <div class="drop-overlay" id="drop-overlay" style="display:none;">
            Drop files here to attach (up to 25 MB)
          </div>

          <button type="button" class="jump-bottom-btn" id="btn-jump-bottom" title="Jump to latest" aria-label="Jump to latest" style="display:none;">${iconArrowDown(16)}</button>

          <div id="slash-menu-container"></div>
          <div id="mention-menu-container"></div>
          <div id="composer-context-container">${this.renderContextBannerHtml()}</div>
          <div class="typing-bar" id="typing-bar" style="${this.typingPeers.length > 0 ? '' : 'display:none;'}">${this.renderTypingText()}</div>

          ${this.composer.renderHtml()}
        </main>
      </div>
      <div id="modal-root"></div>
    `;

    this.bindEvents();
    this.updateCallDockDOM();
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
        <input type="search" id="input-search" value="${escapeAttr(this.searchQuery)}" placeholder="Search messages or filenames..." />
        <button type="button" class="small icon-btn" id="btn-close-search" title="Close search" aria-label="Close search">${iconClose(14)}</button>
      </div>
    `;
  }

  private updateSearchBarDOM(): void {
    const container = this.root.querySelector('#search-bar-container');
    if (!container) return;
    container.innerHTML = this.renderSearchBarHtml();
    if (this.searchOpen) {
      const input = container.querySelector('#input-search') as HTMLInputElement | null;
      input?.addEventListener('input', () => {
        this.searchQuery = input.value;
        this.appendOrRefreshMessages();
      });
      container.querySelector('#btn-close-search')?.addEventListener('click', () => {
        this.searchOpen = false;
        this.searchQuery = '';
        this.root.querySelector('#btn-toggle-search')?.classList.remove('active');
        this.updateSearchBarDOM();
        this.appendOrRefreshMessages();
      });
      input?.focus();
    }
  }

  private renderPeersListHtml(): string {
    if (this.peers.length === 0) {
      return `<div class="peer-empty">No peers connected yet.</div>`;
    }

    return this.peers
      .map((p) => {
        const transportLabel = p.transport === 'local-broadcast' ? 'LOCAL' : 'WEBRTC';
        const rttLabel = p.rttMs !== null ? `${p.rttMs}ms` : '...';
        const isWhispering = this.whisperTarget?.peerId === p.peerId;
        const metaTooltip = `${transportLabel} • ${rttLabel}`;

        return `
          <div class="peer-item" title="${escapeAttr(metaTooltip)}">
            <span class="peer-name">
              ${escapeHtml(p.nickname)}${p.inCall ? ' <span class="badge ok">CALL</span>' : ''}
            </span>
            <button
              type="button"
              class="small ${isWhispering ? 'primary' : ''}"
              data-whisper-id="${escapeAttr(p.peerId)}"
              data-whisper-name="${escapeAttr(p.nickname)}"
              title="Send private 1:1 DM"
            >DM</button>
          </div>
        `;
      })
      .join('');
  }

  private renderContextBannerHtml(): string {
    if (!this.replyTo && !this.whisperTarget) return '';
    const chips: string[] = [];
    if (this.whisperTarget) {
      chips.push(`
        <span class="context-chip">
          <span>DM to <b>@${escapeHtml(this.whisperTarget.nickname)}</b></span>
          <button type="button" class="context-chip-close" id="btn-clear-dm" title="Exit DM mode" aria-label="Exit DM mode">${iconClose(12)}</button>
        </span>
      `);
    }
    if (this.replyTo) {
      chips.push(`
        <span class="context-chip">
          <span>Reply to <b>@${escapeHtml(this.replyTo.senderName)}</b>: "${escapeHtml(
            this.replyTo.text.slice(0, 40)
          )}"</span>
          <button type="button" class="context-chip-close" id="btn-clear-reply" title="Cancel reply" aria-label="Cancel reply">${iconClose(12)}</button>
        </span>
      `);
    }
    return `<div class="composer-context">${chips.join('')}</div>`;
  }

  private renderTypingText(): string {
    if (this.typingPeers.length === 0) return '';
    const names = this.typingPeers.map((t) => escapeHtml(t.nickname)).join(', ');
    return `<span><b>${names}</b> is typing...</span>`;
  }

  private getSignalingBadgeText(): string {
    if (this.signalingState.status === 'ready') return 'ONLINE';
    if (this.signalingState.status === 'initializing') return 'CONNECTING...';
    return 'LOCAL';
  }

  private updateStatusDOM(): void {
    const dot = this.root.querySelector('#sig-dot');
    if (dot) dot.className = `status-dot ${this.signalingState.status}`;
    const label = this.root.querySelector('#sig-label');
    if (label) label.textContent = this.getSignalingBadgeText();
  }

  private updatePeersDOM(): void {
    const listEl = this.root.querySelector('#peer-list-container');
    if (listEl) {
      const nextHtml = this.renderPeersListHtml();
      if (nextHtml !== this.lastPeersListHtml) {
        listEl.innerHTML = nextHtml;
        this.lastPeersListHtml = nextHtml;
      }
    }
    const sideCount = this.root.querySelector('#peer-count-side');
    if (sideCount) sideCount.textContent = String(this.peers.length);
    const topBadge = this.root.querySelector('#topbar-peer-badge');
    if (topBadge) {
      topBadge.className = `badge ${this.peers.length > 0 ? 'ok' : ''}`;
      topBadge.textContent = `${this.peers.length} online`;
    }
  }

  private updateContextBannerDOM(): void {
    const container = this.root.querySelector('#composer-context-container');
    if (!container) return;
    container.innerHTML = this.renderContextBannerHtml();
    container.querySelector('#btn-clear-dm')?.addEventListener('click', () => {
      this.whisperTarget = undefined;
      this.updateContextBannerDOM();
      this.updatePeersDOM();
    });
    container.querySelector('#btn-clear-reply')?.addEventListener('click', () => {
      this.replyTo = undefined;
      this.updateContextBannerDOM();
    });
  }

  private updateTypingDOM(): void {
    const bar = this.root.querySelector('#typing-bar') as HTMLElement | null;
    if (!bar) return;
    if (this.typingPeers.length === 0) {
      bar.style.display = 'none';
      bar.innerHTML = '';
    } else {
      bar.style.display = 'block';
      bar.innerHTML = this.renderTypingText();
    }
  }

  private updateCallDockDOM(): void {
    const container = this.root.querySelector('#call-dock-container') as HTMLElement | null;
    const peersInCall = this.peers.filter((p) => p.inCall);
    this.callDock.render(
      container,
      {
        localStream: this.localCallStream,
        localVideoEnabled: this.localVideoEnabled,
        localMuted: this.localCallMuted,
        isScreenShare: this.isScreenShare,
        canSwitchCamera: this.engine?.canSwitchCamera() ?? false,
        remoteStreams: this.remoteCallStreams,
        peers: this.peers,
        peersInCall,
        myNickname: this.profile.nickname,
      },
      {
        onJoinCall: () => void this.startCallFlow(false),
        onToggleMute: () => this.engine.toggleMute(),
        onToggleVideo: () =>
          void this.engine.toggleVideo().catch((err: any) =>
            this.showToast(err?.message || 'Camera action failed.')
          ),
        onSwitchCamera: () =>
          void this.engine.switchCamera().catch((err: any) =>
            this.showToast(err?.message || 'Camera action failed.')
          ),
        onToggleScreenShare: () => void this.toggleScreenShareFlow(),
        onLeaveCall: () => this.engine.leaveCall(),
      }
    );
  }

  private rerenderSingleMessageRow(messageId: string): void {
    const msg = this.messageMap.get(messageId);
    const row = this.root.querySelector(`.msg-row[data-msg-id="${messageId}"]`);
    if (!msg || !row) return;
    const idx = this.messages.findIndex((m) => m.id === messageId);
    const prev = idx > 0 ? this.messages[idx - 1] : undefined;
    const grouped = shouldGroupMessages(prev, msg);
    row.outerHTML = renderSingleMessageHtml(msg, this.getMessageRenderContext(), grouped);
  }

  private applyReactionLocally(messageId: string, emoji: string, actorId: string): void {
    if (!isAllowedReaction(emoji)) return;
    const msg = this.messageMap.get(messageId);
    if (!msg || msg.deleted) return;
    if (!msg.reactions) msg.reactions = {};
    const list = msg.reactions[emoji] ? [...msg.reactions[emoji]] : [];
    const existingIdx = list.indexOf(actorId);
    if (existingIdx >= 0) {
      list.splice(existingIdx, 1);
    } else {
      list.push(actorId);
    }
    if (list.length === 0) {
      delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji] = list;
    }
    this.rerenderSingleMessageRow(messageId);
  }

  private appendSingleMessageDOM(msg: ChatMessage, evicted: boolean): void {
    if (this.searchQuery.trim()) {
      this.appendOrRefreshMessages();
      return;
    }
    const stream = this.root.querySelector('#message-stream') as HTMLElement | null;
    if (!stream) return;

    const wasAtBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 65;
    stream.querySelector('.empty-state')?.remove();
    if (evicted) {
      stream.querySelector('.msg-row')?.remove();
      if (this.messages[0]) {
        this.rerenderSingleMessageRow(this.messages[0].id);
      }
    }
    const prev = this.messages.length >= 2 ? this.messages[this.messages.length - 2] : undefined;
    const grouped = shouldGroupMessages(prev, msg);
    stream.insertAdjacentHTML(
      'beforeend',
      renderSingleMessageHtml(msg, this.getMessageRenderContext(), grouped)
    );

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

    const wasAtBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 65;
    stream.innerHTML = renderMessagesListHtml(this.messages, this.getMessageRenderContext());

    if (wasAtBottom) {
      this.scrollToBottom();
    } else {
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
      btn.classList.add('has-unread');
      btn.innerHTML = `${iconArrowDown(15)}<span class="jump-unread-count">${this.unreadWhileScrolled}</span>`;
      btn.setAttribute(
        'aria-label',
        `Jump to ${this.unreadWhileScrolled} new message${this.unreadWhileScrolled > 1 ? 's' : ''}`
      );
    } else if (!this.isAtBottom) {
      btn.style.display = 'inline-flex';
      btn.classList.remove('has-unread');
      btn.innerHTML = iconArrowDown(16);
      btn.setAttribute('aria-label', 'Jump to latest');
    } else {
      btn.style.display = 'none';
    }
  }

  private async openInviteModal(): Promise<void> {
    this.activeModal = 'invite';
    this.inviteQrSvg = await generateQrSvg(this.getInviteUrl());
    this.renderModal();
  }

  private async openFilePreviewModal(messageId: string): Promise<void> {
    const msg = this.messageMap.get(messageId);
    const att = msg?.attachment;
    if (!att?.url || !att.url.startsWith('blob:')) return;

    const kind = classifyFilePreview(att.mimeType, att.name);
    if (kind === 'none') return;

    if (kind === 'pdf') {
      this.filePreview = {
        kind: 'pdf',
        name: att.name,
        url: att.url,
        sizeLabel: formatFileSize(att.size),
      };
      this.activeModal = 'file-preview';
      this.renderModal();
      return;
    }

    const blob = this.blobs.get(att.url);
    if (!blob) {
      this.showToast('Could not preview file');
      return;
    }

    try {
      const { text, truncated, isBinary } = await readBlobPreviewText(blob);
      const delimiter: ',' | '\t' =
        att.name.toLowerCase().endsWith('.tsv') || att.mimeType === 'text/tab-separated-values'
          ? '\t'
          : ',';
      this.filePreview = {
        kind,
        name: att.name,
        url: att.url,
        sizeLabel: formatFileSize(att.size),
        text: isBinary ? undefined : text,
        truncated,
        csvViewMode: 'table',
        delimiter,
        error: isBinary ? 'Binary content detected — use SAVE to download.' : undefined,
      };
      this.activeModal = 'file-preview';
      this.renderModal();
    } catch {
      this.showToast('Could not preview file');
    }
  }

  private renderModal(): void {
    const modalRoot = this.root.querySelector('#modal-root') as HTMLElement | null;
    renderModalDOM(
      modalRoot,
      {
        activeModal: this.activeModal,
        roomId: this.roomId,
        inviteUrl: this.getInviteUrl(),
        inviteQrSvg: this.inviteQrSvg,
        lightboxUrl: this.lightboxUrl,
        lightboxName: this.lightboxName,
        filePreview: this.filePreview,
      },
      {
        onClose: () => {
          this.activeModal = 'none';
          this.renderModal();
        },
        onToast: (msg) => this.showToast(msg),
        onToggleCsvMode: () => {
          if (this.filePreview && this.filePreview.kind === 'csv') {
            this.filePreview.csvViewMode =
              this.filePreview.csvViewMode === 'raw' ? 'table' : 'raw';
            this.renderModal();
          }
        },
      }
    );
  }

  // =========================================================================
  // EVENT BINDINGS
  // =========================================================================
  private bindEvents(): void {
    this.root.querySelector('#brand-logo')?.addEventListener('click', (e) => {
      const me = e as MouseEvent;
      if (me.ctrlKey || me.metaKey || me.shiftKey || me.button === 1) return;
      e.preventDefault();
      window.location.reload();
    });
    this.root.querySelector('#btn-open-drawer')?.addEventListener('click', () => {
      this.setMobileDrawerOpen(true);
    });
    this.root.querySelector('#btn-close-drawer')?.addEventListener('click', () => {
      this.setMobileDrawerOpen(false);
    });
    this.root.querySelector('#drawer-backdrop')?.addEventListener('click', () => {
      this.setMobileDrawerOpen(false);
    });

    // Topbar actions
    this.root.querySelector('#btn-topbar-invite')?.addEventListener('click', () => {
      this.notifications.unlockAudio();
      void this.openInviteModal();
    });
    this.root.querySelector('#btn-mute-sound')?.addEventListener('click', () => {
      this.notifications.unlockAudio();
      this.toggleSoundMute();
    });

    // Text Size, Theme, Help
    this.root.querySelector('#btn-size-dec')?.addEventListener('click', () => {
      this.setFontSize(this.fontSizePx - FONT_SIZE_STEP);
    });
    this.root.querySelector('#btn-size-reset')?.addEventListener('click', () => {
      this.setFontSize(DEFAULT_FONT_SIZE);
    });
    this.root.querySelector('#btn-size-inc')?.addEventListener('click', () => {
      this.setFontSize(this.fontSizePx + FONT_SIZE_STEP);
    });
    this.root.querySelector('#btn-theme')?.addEventListener('click', () => {
      this.setTheme(undefined, false);
    });
    this.root.querySelector('#btn-help')?.addEventListener('click', () => {
      this.setMobileDrawerOpen(false);
      this.activeModal = 'help';
      this.renderModal();
    });

    // Nickname
    const saveNick = () => {
      const input = this.root.querySelector('#input-nick') as HTMLInputElement | null;
      if (!this.setNickname(input?.value || '') && input) {
        input.value = this.profile.nickname;
      }
    };
    this.root.querySelector('#btn-save-nick')?.addEventListener('click', saveNick);
    this.root.querySelector('#input-nick')?.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.isComposing || ke.keyCode === 229) return;
      if (ke.key === 'Enter') {
        ke.preventDefault();
        saveNick();
      }
    });

    // Rooms
    const joinRoomFromInput = () => {
      const input = this.root.querySelector('#input-room') as HTMLInputElement | null;
      if (input && input.value.trim()) {
        void this.switchRoom(input.value.trim());
      }
    };
    this.root.querySelector('#btn-join-room')?.addEventListener('click', joinRoomFromInput);
    this.root.querySelector('#input-room')?.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.isComposing || ke.keyCode === 229) return;
      if (ke.key === 'Enter') {
        ke.preventDefault();
        joinRoomFromInput();
      }
    });
    this.root.querySelector('#btn-lobby-room')?.addEventListener('click', () => {
      void this.switchRoom('LOBBY');
    });
    this.root.querySelector('#btn-new-room')?.addEventListener('click', () => {
      void this.switchToRandomRoom();
    });

    // Search
    this.root.querySelector('#btn-toggle-search')?.addEventListener('click', (e) => {
      this.searchOpen = !this.searchOpen;
      (e.currentTarget as HTMLElement | null)?.classList.toggle('active', this.searchOpen);
      if (!this.searchOpen && this.searchQuery) {
        this.searchQuery = '';
        this.appendOrRefreshMessages();
      }
      this.updateSearchBarDOM();
    });
    this.updateSearchBarDOM();

    // Stream Scroll & Drag/Drop File Upload
    const stream = this.root.querySelector('#message-stream') as HTMLElement | null;
    stream?.addEventListener('scroll', () => {
      const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 50;
      this.isAtBottom = atBottom;
      if (atBottom) this.unreadWhileScrolled = 0;
      this.updateJumpButtonDOM();
    });
    this.root.querySelector('#btn-jump-bottom')?.addEventListener('click', () => {
      this.scrollToBottom();
    });

    const chatPane = this.root.querySelector('#chat-pane') as HTMLElement | null;
    const dropOverlay = this.root.querySelector('#drop-overlay') as HTMLElement | null;
    let dragDepth = 0;
    chatPane?.addEventListener('dragenter', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        dragDepth++;
        if (dropOverlay) dropOverlay.style.display = 'flex';
      }
    });
    chatPane?.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 && dropOverlay) dropOverlay.style.display = 'none';
    });
    chatPane?.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    chatPane?.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      if (dropOverlay) dropOverlay.style.display = 'none';
      if (e.dataTransfer?.files?.length) {
        this.composer.stageFiles(e.dataTransfer.files);
      }
    });

    // Composer
    this.composer.bindEvents();
    const form = this.root.querySelector('#composer-form') as HTMLFormElement | null;
    const textarea = this.composer.getTextarea();

    textarea?.addEventListener('input', () => {
      this.composer.autoResize();
      this.handleComposerTypingInput(textarea.value);
    });

    textarea?.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;

      const matches = getMatchingSlashCommands(textarea.value, this.slashMenuDismissed);
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
          e.stopPropagation();
          this.slashMenuDismissed = true;
          this.updateSlashMenuDOM(textarea.value);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const chosen = matches[this.slashMenuIndex] || matches[0];
          textarea.value = chosen.instant ? chosen.cmd : `${chosen.cmd} `;
          this.composer.autoResize();
          this.updateSlashMenuDOM(textarea.value);
          textarea.focus();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          const chosen = matches[this.slashMenuIndex] || matches[0];
          const trimmed = textarea.value.trim().toLowerCase();
          if (chosen.instant || (!chosen.needsArgs && trimmed === chosen.cmd)) {
            e.preventDefault();
            textarea.value = '';
            this.composer.autoResize();
            this.updateSlashMenuDOM('');
            this.handleSendMessage(chosen.cmd);
            return;
          }
          e.preventDefault();
          this.applySlashCommandSelection(chosen, textarea);
          return;
        }
      }

      const mentionMatches = getMatchingMentions(
        textarea.value,
        this.profile.nickname,
        this.peers,
        this.mentionMenuDismissed
      );
      if (mentionMatches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.mentionMenuIndex = (this.mentionMenuIndex + 1) % mentionMatches.length;
          this.updateMentionMenuDOM(textarea.value);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.mentionMenuIndex =
            (this.mentionMenuIndex - 1 + mentionMatches.length) % mentionMatches.length;
          this.updateMentionMenuDOM(textarea.value);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.mentionMenuDismissed = true;
          this.updateMentionMenuDOM(textarea.value);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          const chosen = mentionMatches[this.mentionMenuIndex] || mentionMatches[0];
          this.applyMentionSelection(chosen, textarea);
          return;
        }
      }

      const isCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
      if (e.key === 'Enter' && !e.shiftKey && !isCoarsePointer) {
        e.preventDefault();
        this.submitComposerInput(false);
      }
    });

    const sendBtn = form?.querySelector('.send-btn') as HTMLButtonElement | null;
    let composerFocusedBeforeSend = false;
    sendBtn?.addEventListener('pointerdown', () => {
      composerFocusedBeforeSend = Boolean(textarea && document.activeElement === textarea);
    });
    sendBtn?.addEventListener('mousedown', (e) => {
      if (textarea && document.activeElement === textarea) {
        e.preventDefault();
      }
    });

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      if ((textarea && textarea.value.trim()) || this.composer.hasStagedFiles()) {
        const isTouch = window.matchMedia?.('(hover: none)').matches;
        const shouldRefocus =
          !isTouch || composerFocusedBeforeSend || document.activeElement === textarea;
        composerFocusedBeforeSend = false;
        this.submitComposerInput(shouldRefocus);
      } else {
        composerFocusedBeforeSend = false;
      }
    });

    this.bindPeerItemEvents();
    this.bindMessageStreamEvents();
    this.bindMobileGestures();
    this.updateContextBannerDOM();
  }

  private submitComposerInput(refocusAfter: boolean): void {
    const textarea = this.composer.getTextarea();
    const rawVal = textarea?.value ?? '';
    const hasText = Boolean(rawVal.trim());
    const stagedFiles = this.composer.takeStagedFiles();
    if (!hasText && stagedFiles.length === 0) return;

    if (textarea) {
      textarea.value = '';
      this.composer.autoResize();
    }
    this.updateSlashMenuDOM('');
    this.updateMentionMenuDOM('');
    this.composer.closeNonVoicePopovers();

    if (stagedFiles.length > 0) {
      void this.handleSelectedFiles(stagedFiles).then(() => {
        if (hasText) {
          this.handleSendMessage(rawVal);
        }
      });
    } else if (hasText) {
      this.handleSendMessage(rawVal);
    }

    if (refocusAfter && textarea) {
      textarea.focus({ preventScroll: true });
    }
  }

  private handleComposerTypingInput(val: string): void {
    this.slashMenuDismissed = false;
    this.slashMenuIndex = 0;
    this.updateSlashMenuDOM(val);

    this.mentionMenuDismissed = false;
    this.mentionMenuIndex = 0;
    this.updateMentionMenuDOM(val);

    const now = Date.now();
    if (val.trim().length > 0) {
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
  }

  private applySlashCommandSelection(item: SlashCommandDef, textarea: HTMLTextAreaElement): void {
    textarea.value = `${item.cmd} `;
    this.composer.autoResize();
    this.updateSlashMenuDOM(textarea.value);
    textarea.focus();
  }

  private updateSlashMenuDOM(rawInput: string): void {
    const container = this.root.querySelector('#slash-menu-container') as HTMLElement | null;
    if (!container) return;

    const matches = getMatchingSlashCommands(rawInput, this.slashMenuDismissed);
    if (matches.length === 0) {
      container.innerHTML = '';
      return;
    }

    if (this.slashMenuIndex >= matches.length) this.slashMenuIndex = 0;

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
            <span class="slash-cmd">${escapeHtml(item.usage)}</span>
            <span class="slash-desc">${escapeHtml(item.desc)}</span>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    const activeEl = container.querySelector('.slash-item.active') as HTMLElement | null;
    activeEl?.scrollIntoView({ block: 'nearest' });

    const textarea = this.composer.getTextarea();
    container.querySelectorAll('[data-slash-idx]').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = Number(el.getAttribute('data-slash-idx') || 0);
        const chosen = matches[idx];
        if (chosen && textarea) {
          if (chosen.instant) {
            textarea.value = '';
            this.composer.autoResize();
            this.updateSlashMenuDOM('');
            this.handleSendMessage(chosen.cmd);
            textarea.focus();
          } else {
            this.applySlashCommandSelection(chosen, textarea);
          }
        }
      });
    });
  }

  private applyMentionSelection(
    item: { tag: string; label: string; desc: string },
    textarea: HTMLTextAreaElement
  ): void {
    textarea.value = textarea.value.replace(/(@[a-zA-Z0-9_\-\uAC00-\uD7A3]*)$/i, `${item.tag} `);
    this.composer.autoResize();
    this.updateMentionMenuDOM(textarea.value);
    textarea.focus();
  }

  private updateMentionMenuDOM(rawInput: string): void {
    const container = this.root.querySelector('#mention-menu-container') as HTMLElement | null;
    if (!container) return;

    const matches = getMatchingMentions(
      rawInput,
      this.profile.nickname,
      this.peers,
      this.mentionMenuDismissed
    );
    if (matches.length === 0) {
      container.innerHTML = '';
      return;
    }

    if (this.mentionMenuIndex >= matches.length) this.mentionMenuIndex = 0;

    container.innerHTML = `
      <div class="slash-menu mention-menu" id="mention-menu">
        <div class="slash-menu-header">
          <span>Mentions (${matches.length})</span>
          <span>↑↓ Navigate • Tab/Enter Select</span>
        </div>
        ${matches
          .map(
            (item, idx) => `
          <div class="slash-item ${idx === this.mentionMenuIndex ? 'active' : ''}" data-mention-idx="${idx}">
            <span class="slash-cmd">${escapeHtml(item.label)}</span>
            <span class="slash-desc">${escapeHtml(item.desc)}</span>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    const activeEl = container.querySelector('.slash-item.active') as HTMLElement | null;
    activeEl?.scrollIntoView({ block: 'nearest' });

    const textarea = this.composer.getTextarea();
    container.querySelectorAll('[data-mention-idx]').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = Number(el.getAttribute('data-mention-idx') || 0);
        const chosen = matches[idx];
        if (chosen && textarea) this.applyMentionSelection(chosen, textarea);
      });
    });
  }

  private bindPeerItemEvents(): void {
    const peerContainer = this.root.querySelector('#peer-list-container');
    peerContainer?.addEventListener('click', (e) => {
      const targetEl = e.target as HTMLElement | null;
      if (!targetEl) return;

      const btn = targetEl.closest('[data-whisper-id]');
      if (!btn) return;
      const peerId = btn.getAttribute('data-whisper-id') || '';
      const nickname = btn.getAttribute('data-whisper-name') || 'peer';
      this.whisperTarget =
        this.whisperTarget?.peerId === peerId ? undefined : { peerId, nickname };
      this.setMobileDrawerOpen(false);
      this.updatePeersDOM();
      this.updateContextBannerDOM();
      this.composer.getTextarea()?.focus({ preventScroll: true });
    });
  }

  private bindMessageStreamEvents(): void {
    const stream = this.root.querySelector('#message-stream');
    const clearOpenToolbars = () => {
      stream?.querySelectorAll('.msg-row.toolbar-open').forEach((r) => {
        r.classList.remove('toolbar-open');
      });
    };

    stream?.addEventListener(
      'load',
      (e) => {
        const el = e.target as HTMLElement | null;
        if (el && el.classList.contains('msg-media-img') && this.isAtBottom) {
          this.scrollToBottom();
        }
      },
      true
    );

    stream?.addEventListener('click', (e) => {
      const targetEl = e.target as HTMLElement | null;
      if (!targetEl) return;

      if (!targetEl.closest('.reaction-picker') && !targetEl.closest('[data-react-open]')) {
        stream.querySelectorAll('.reaction-picker-slot:not(:empty)').forEach((s) => {
          s.innerHTML = '';
        });
      }

      if (targetEl.closest('#btn-empty-invite')) {
        void this.openInviteModal();
        return;
      }

      if (targetEl.closest('#btn-empty-new-room')) {
        void this.switchToRandomRoom();
        return;
      }

      const lightboxImg = targetEl.closest('[data-lightbox-url]');
      if (lightboxImg) {
        this.lightboxUrl = lightboxImg.getAttribute('data-lightbox-url') || '';
        this.lightboxName = lightboxImg.getAttribute('data-lightbox-name') || 'image';
        this.activeModal = 'lightbox';
        this.renderModal();
        return;
      }

      if (!targetEl.closest('a[download]')) {
        const previewEl = targetEl.closest('[data-preview-id]');
        if (previewEl) {
          const id = previewEl.getAttribute('data-preview-id') || '';
          if (id) void this.openFilePreviewModal(id);
          return;
        }
      }

      const cancelTransferBtn = targetEl.closest('[data-cancel-transfer]');
      if (cancelTransferBtn) {
        const tid = cancelTransferBtn.getAttribute('data-cancel-transfer') || '';
        if (tid) this.engine.cancelMediaTransfer(tid);
        return;
      }

      const retryBtn = targetEl.closest('[data-retry-id]');
      if (retryBtn) {
        const id = retryBtn.getAttribute('data-retry-id') || '';
        const target = this.messageMap.get(id);
        if (target) {
          target.deliveryState = 'sent';
          this.rerenderSingleMessageRow(id);
          void this.engine.retryChatMessage(target);
        }
        return;
      }

      const deleteBtn = targetEl.closest('[data-delete-id]');
      if (deleteBtn) {
        clearOpenToolbars();
        const id = deleteBtn.getAttribute('data-delete-id') || '';
        const idx = this.messages.findIndex((m) => m.id === id);
        const target = idx >= 0 ? this.messages[idx] : this.messageMap.get(id);
        if (target) {
          target.deleted = true;
          target.text = '';
          if (target.attachment?.url) this.blobs.revoke(target.attachment.url);
          target.attachment = undefined;
          this.rerenderSingleMessageRow(id);
          if (idx >= 0 && this.messages[idx + 1]) {
            this.rerenderSingleMessageRow(this.messages[idx + 1].id);
          }
          void this.engine.deleteMessage(id);
        }
        return;
      }

      const reactOpenBtn = targetEl.closest('[data-react-open]');
      if (reactOpenBtn) {
        const id = reactOpenBtn.getAttribute('data-react-open') || '';
        const slot = stream.querySelector(`[data-react-slot="${id}"]`);
        const wasOpen = Boolean(slot && slot.innerHTML !== '');
        stream.querySelectorAll('.reaction-picker-slot:not(:empty)').forEach((s) => {
          s.innerHTML = '';
        });
        if (slot && !wasOpen) {
          slot.innerHTML = renderReactionPickerHtml(id);
        }
        return;
      }

      const reactBtn = targetEl.closest('[data-react-id]');
      if (reactBtn) {
        clearOpenToolbars();
        const id = reactBtn.getAttribute('data-react-id') || '';
        const emoji = reactBtn.getAttribute('data-react-emoji') || '';
        if (id && emoji) {
          const slot = stream.querySelector(`[data-react-slot="${id}"]`);
          if (slot) slot.innerHTML = '';
          this.applyReactionLocally(id, emoji, this.engine.getMyPeerId());
          void this.engine.sendReaction(id, emoji);
        }
        return;
      }

      const copyBtn = targetEl.closest('[data-copy-id]');
      if (copyBtn) {
        clearOpenToolbars();
        const id = copyBtn.getAttribute('data-copy-id') || '';
        const target = this.messageMap.get(id);
        if (target) {
          void copyTextToClipboard(target.text).then((ok) =>
            this.showToast(ok ? 'Message copied' : 'Could not copy message')
          );
        }
        return;
      }

      const replyBtn = targetEl.closest('[data-reply-id]');
      if (replyBtn) {
        clearOpenToolbars();
        const id = replyBtn.getAttribute('data-reply-id') || '';
        const senderName = replyBtn.getAttribute('data-reply-sender') || '';
        const text = replyBtn.getAttribute('data-reply-text') || '';
        this.replyTo = { id, senderName, text };
        this.updateContextBannerDOM();
        this.composer.getTextarea()?.focus({ preventScroll: true });
        return;
      }

      if (!window.matchMedia('(hover: hover)').matches) {
        if (
          targetEl.closest(
            'button, a, video, audio, [data-lightbox-url], [data-preview-id], .reaction-picker, .msg-toolbar'
          ) ||
          window.getSelection()?.toString()
        ) {
          return;
        }
        const row = targetEl.closest('.msg-row:not(.system)') as HTMLElement | null;
        if (!row || !row.querySelector('.msg-toolbar')) {
          clearOpenToolbars();
          return;
        }
        const wasOpen = row.classList.contains('toolbar-open');
        clearOpenToolbars();
        if (!wasOpen) row.classList.add('toolbar-open');
      }
    });
  }

  private bindMobileGestures(): void {
    const layout = this.root.querySelector('.layout') as HTMLElement | null;
    if (!layout) return;

    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let validTouch = false;

    layout.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (window.innerWidth > 768 || e.touches.length !== 1 || this.activeModal !== 'none') {
          validTouch = false;
          return;
        }
        const target = e.target as HTMLElement | null;
        if (
          !target ||
          target.closest(
            'button, input, textarea, a, select, pre, code, video, audio, .composer-popover, .call-dock'
          )
        ) {
          validTouch = false;
          return;
        }

        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        startTime = Date.now();

        if (!this.mobileDrawerOpen) {
          const inChat = Boolean(target.closest('.chat-pane'));
          const notEdge = startX > window.innerWidth * 0.05;
          validTouch = inChat && notEdge;
        } else {
          validTouch = Boolean(target.closest('#sidebar, #drawer-backdrop'));
        }
      },
      { passive: true }
    );

    layout.addEventListener(
      'touchcancel',
      () => {
        validTouch = false;
      },
      { passive: true }
    );

    layout.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        if (!validTouch || e.changedTouches.length === 0) return;
        validTouch = false;

        const touch = e.changedTouches[0];
        const deltaX = touch.clientX - startX;
        const deltaY = touch.clientY - startY;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        const elapsed = Date.now() - startTime;

        if (elapsed > 500 || absX < absY * 1.5) return;

        const threshold = Math.max(45, window.innerWidth * 0.15);
        if (!this.mobileDrawerOpen && deltaX > threshold) {
          this.setMobileDrawerOpen(true);
        } else if (this.mobileDrawerOpen && deltaX < -threshold) {
          this.setMobileDrawerOpen(false);
        }
      },
      { passive: true }
    );
  }
}

const appRoot = document.getElementById('app');
if (appRoot) {
  new RevChatApp(appRoot);
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
