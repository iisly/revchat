import { ASCII_EMOTE_LIST } from '../commands';
import { escapeAttr, escapeHtml } from '../markdown';
import {
  MAX_MEDIA_BYTES,
  MAX_VOICE_SECONDS,
  VoiceRecorder,
  classifyMime,
  extractClipboardFiles,
  formatDuration,
  formatFileSize,
  inferMimeFromFilename,
  normalizePastedFile,
} from '../media';
import { generateUUID } from '../storage';
import {
  iconArrowLeft,
  iconClose,
  iconGamepad,
  iconMic,
  iconPaperclip,
  iconPhone,
  iconPlus,
  iconSend,
  iconSmile,
} from './icons';

type PopoverMode = 'none' | 'plus' | 'emotes' | 'voice';
type PlusSubview = 'root' | 'games';

export interface ComposerCallbacks {
  onTypingInput: (text: string) => void;
  onStartCall: (video: boolean) => void;
  onSendVoice: (blob: Blob, mimeType: string, durationSec: number) => void;
  onRunQuickCommand: (cmdLine: string) => void;
  onPreviewStagedImage: (url: string, name: string) => void;
  onToast: (text: string) => void;
  isInCall: () => boolean;
}

interface StagedAttachment {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  size: number;
  isImage: boolean;
  previewUrl?: string;
}

export class ComposerController {
  private static readonly MAX_STAGED_FILES = 10;

  private root: HTMLElement;
  private roomId: string;
  private callbacks: ComposerCallbacks;

  private popoverMode: PopoverMode = 'none';
  private plusSubview: PlusSubview = 'root';
  private voiceRecorder = new VoiceRecorder();
  private voiceSeconds = 0;
  private stagedFiles: StagedAttachment[] = [];

  constructor(root: HTMLElement, roomId: string, callbacks: ComposerCallbacks) {
    this.root = root;
    this.roomId = roomId;
    this.callbacks = callbacks;
  }

  public setRoomId(roomId: string): void {
    this.roomId = roomId;
    const ta = this.getTextarea();
    if (ta) ta.placeholder = `Message #${roomId}`;
  }

  public hasOpenPopover(): boolean {
    return this.popoverMode !== 'none';
  }

  public closeNonVoicePopovers(): void {
    if (this.popoverMode === 'plus' || this.popoverMode === 'emotes') {
      this.closePopovers();
    }
  }

  public closePopovers(): void {
    if (this.popoverMode === 'voice') {
      this.voiceRecorder.cancel();
    }
    this.popoverMode = 'none';
    this.plusSubview = 'root';
    this.renderPopoverDOM();
  }

  public hasStagedFiles(): boolean {
    return this.stagedFiles.length > 0;
  }

  public stageFiles(fileList: FileList | File[]): void {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    let added = 0;
    for (const raw of incoming) {
      const file = normalizePastedFile(raw);
      if (file.size === 0) {
        this.callbacks.onToast(`Skipped empty file: ${file.name}`);
        continue;
      }
      const mime = file.type || inferMimeFromFilename(file.name);
      const kind = classifyMime(mime, file.name);
      if (kind !== 'image' && file.size > MAX_MEDIA_BYTES) {
        this.callbacks.onToast(`${file.name} exceeds 25 MB limit.`);
        continue;
      }
      if (this.stagedFiles.length >= ComposerController.MAX_STAGED_FILES) {
        this.callbacks.onToast(`Up to ${ComposerController.MAX_STAGED_FILES} attachments at a time.`);
        break;
      }
      const isImage = kind === 'image';
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      this.stagedFiles.push({
        id: generateUUID(),
        file,
        name: file.name,
        mimeType: mime,
        size: file.size,
        isImage,
        previewUrl,
      });
      added++;
    }

    if (added > 0) {
      this.closeNonVoicePopovers();
      this.renderAttachmentsDOM();
      if (!this.isTouchDevice()) {
        this.getTextarea()?.focus({ preventScroll: true });
      }
    }
  }

  public removeStagedFile(id: string): void {
    const idx = this.stagedFiles.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const [removed] = this.stagedFiles.splice(idx, 1);
    if (removed.previewUrl) {
      URL.revokeObjectURL(removed.previewUrl);
    }
    this.renderAttachmentsDOM();
  }

  public takeStagedFiles(): File[] {
    if (this.stagedFiles.length === 0) return [];
    const files = this.stagedFiles.map((s) => s.file);
    this.clearStagedFiles();
    return files;
  }

  public clearStagedFiles(): void {
    for (const s of this.stagedFiles) {
      if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
    }
    if (this.stagedFiles.length === 0) return;
    this.stagedFiles = [];
    this.renderAttachmentsDOM();
  }

  private renderAttachmentsDOM(): void {
    const slot = this.root.querySelector('#composer-attachments-slot') as HTMLElement | null;
    if (!slot) return;
    if (this.stagedFiles.length === 0) {
      slot.innerHTML = '';
      return;
    }

    slot.innerHTML = `
      <div class="composer-attachments" role="list" aria-label="Pending attachments">
        ${this.stagedFiles
          .map((item) => {
            const safeId = escapeAttr(item.id);
            const safeName = escapeHtml(item.name);
            const safeAttrName = escapeAttr(item.name);
            const sizeStr = formatFileSize(item.size);
            if (item.isImage && item.previewUrl) {
              return `
                <div class="staged-item staged-image" role="listitem" title="${escapeAttr(`${item.name} • ${sizeStr}`)}">
                  <img
                    src="${escapeAttr(item.previewUrl)}"
                    alt="${safeAttrName}"
                    class="staged-thumb"
                    data-staged-preview="${safeId}"
                  />
                  <button
                    type="button"
                    class="staged-remove-btn"
                    data-staged-remove="${safeId}"
                    title="Remove ${safeAttrName}"
                    aria-label="Remove ${safeAttrName}"
                  >${iconClose(11)}</button>
                </div>
              `;
            }
            return `
              <div class="staged-item staged-file" role="listitem" title="${escapeAttr(`${item.name} • ${sizeStr}`)}">
                <span class="staged-file-icon" aria-hidden="true">${iconPaperclip(14)}</span>
                <span class="staged-file-meta">
                  <span class="staged-file-name">${safeName}</span>
                  <span class="staged-file-size">${sizeStr}</span>
                </span>
                <button
                  type="button"
                  class="staged-remove-btn"
                  data-staged-remove="${safeId}"
                  title="Remove ${safeAttrName}"
                  aria-label="Remove ${safeAttrName}"
                >${iconClose(11)}</button>
              </div>
            `;
          })
          .join('')}
      </div>
    `;

    slot.querySelectorAll('[data-staged-remove]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-staged-remove');
        if (id) this.removeStagedFile(id);
      });
    });

    slot.querySelectorAll('[data-staged-preview]').forEach((imgEl) => {
      imgEl.addEventListener('click', () => {
        const id = imgEl.getAttribute('data-staged-preview');
        const item = this.stagedFiles.find((s) => s.id === id);
        if (item?.previewUrl) {
          this.callbacks.onPreviewStagedImage(item.previewUrl, item.name);
        }
      });
      imgEl.addEventListener('error', () => {
        const id = imgEl.getAttribute('data-staged-preview');
        const item = this.stagedFiles.find((s) => s.id === id);
        if (item && item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
          item.previewUrl = undefined;
          item.isImage = false;
          this.renderAttachmentsDOM();
        }
      });
    });
  }

  private isTouchDevice(): boolean {
    return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
  }

  public getTextarea(): HTMLTextAreaElement | null {
    return this.root.querySelector('#composer-input') as HTMLTextAreaElement | null;
  }

  public insertTextAndFocus(snippet: string): void {
    const ta = this.getTextarea();
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    ta.value = `${before}${snippet}${after}`;
    const cursor = start + snippet.length;
    this.autoResize();
    this.callbacks.onTypingInput(ta.value);
    if (!this.isTouchDevice()) {
      ta.setSelectionRange(cursor, cursor);
      ta.focus({ preventScroll: true });
    } else {
      ta.scrollTop = ta.scrollHeight;
    }
  }

  public autoResize(): void {
    const ta = this.getTextarea();
    if (!ta) return;
    ta.style.height = '38px';
    if (!ta.value) {
      ta.style.overflowY = 'hidden';
      return;
    }
    const nextHeight = Math.min(120, Math.max(38, ta.scrollHeight));
    ta.style.height = `${nextHeight}px`;
    ta.style.overflowY = ta.scrollHeight > 120 ? 'auto' : 'hidden';
  }

  public renderHtml(): string {
    return `
      <div id="composer-popover-slot"></div>
      <div id="composer-attachments-slot"></div>
      <form class="composer" id="composer-form">
        <button
          type="button"
          class="composer-tool-btn"
          id="btn-plus-drawer"
          title="Actions (Call, Voice, File, Game)"
          aria-label="Actions"
          aria-expanded="false"
        >${iconPlus(20)}</button>
        <textarea
          id="composer-input"
          rows="1"
          placeholder="Message #${escapeAttr(this.roomId)}"
        ></textarea>
        <button
          type="button"
          class="composer-tool-btn"
          id="btn-emote-picker"
          title="ASCII emotes"
          aria-label="ASCII emotes"
          aria-expanded="false"
        >${iconSmile(20)}</button>
        <button type="submit" class="primary composer-tool-btn send-btn" title="Send message" aria-label="Send message">${iconSend(20)}</button>
        <input type="file" id="file-pick-any" multiple hidden />
      </form>
    `;
  }

  public bindEvents(): void {
    const plusBtn = this.root.querySelector('#btn-plus-drawer');
    const emoteBtn = this.root.querySelector('#btn-emote-picker');
    const fileInput = this.root.querySelector('#file-pick-any') as HTMLInputElement | null;

    plusBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.popoverMode === 'plus') {
        this.closePopovers();
      } else {
        if (this.isTouchDevice()) this.getTextarea()?.blur();
        if (this.popoverMode === 'voice') this.voiceRecorder.cancel();
        this.popoverMode = 'plus';
        this.plusSubview = 'root';
        this.renderPopoverDOM();
      }
    });

    emoteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.popoverMode === 'emotes') {
        this.closePopovers();
      } else {
        if (this.isTouchDevice()) this.getTextarea()?.blur();
        if (this.popoverMode === 'voice') this.voiceRecorder.cancel();
        this.popoverMode = 'emotes';
        this.renderPopoverDOM();
      }
    });

    fileInput?.addEventListener('change', () => {
      if (fileInput.files?.length) {
        this.stageFiles(fileInput.files);
        fileInput.value = '';
      }
      this.closeNonVoicePopovers();
    });

    const ta = this.getTextarea();
    ta?.addEventListener('focus', () => {
      if (this.isTouchDevice()) this.closeNonVoicePopovers();
    });
    ta?.addEventListener('paste', (e) => {
      const files = extractClipboardFiles(e.clipboardData);
      if (files.length > 0) {
        e.preventDefault();
        this.stageFiles(files);
      }
    });

    this.renderAttachmentsDOM();
    this.renderPopoverDOM();
  }

  private renderPopoverDOM(): void {
    const slot = this.root.querySelector('#composer-popover-slot') as HTMLElement | null;
    if (!slot) return;

    const plusBtn = this.root.querySelector('#btn-plus-drawer');
    const emoteBtn = this.root.querySelector('#btn-emote-picker');
    plusBtn?.setAttribute('aria-expanded', String(this.popoverMode === 'plus'));
    emoteBtn?.setAttribute('aria-expanded', String(this.popoverMode === 'emotes'));
    plusBtn?.classList.toggle('active', this.popoverMode === 'plus');
    emoteBtn?.classList.toggle('active', this.popoverMode === 'emotes');

    if (this.popoverMode === 'none') {
      slot.innerHTML = '';
      return;
    }

    if (this.popoverMode === 'voice') {
      slot.innerHTML = `
        <div class="voice-recorder-bar">
          <div class="voice-rec-status">
            <span class="rec-dot"></span>
            <span>REC</span>
            <code id="voice-rec-timer">${formatDuration(this.voiceSeconds)} / ${formatDuration(MAX_VOICE_SECONDS)}</code>
          </div>
          <div class="voice-rec-actions">
            <button type="button" class="small" id="btn-voice-cancel">CANCEL</button>
            <button type="button" class="small primary" id="btn-voice-send">SEND</button>
          </div>
        </div>
      `;
      slot.querySelector('#btn-voice-cancel')?.addEventListener('click', () => {
        this.closePopovers();
      });
      slot.querySelector('#btn-voice-send')?.addEventListener('click', async () => {
        const res = await this.voiceRecorder.stop();
        this.popoverMode = 'none';
        this.renderPopoverDOM();
        if (res && res.blob.size > 0) {
          this.callbacks.onSendVoice(res.blob, res.mimeType, res.durationSec);
        } else {
          this.callbacks.onToast('Voice message was empty.');
        }
      });
      return;
    }

    if (this.popoverMode === 'emotes') {
      slot.innerHTML = `
        <div class="composer-popover" id="composer-popover">
          <div class="popover-header">
            <span>ASCII EMOTES</span>
            <button type="button" class="small icon-btn" id="btn-popover-close" title="Close" aria-label="Close">${iconClose(16)}</button>
          </div>
          <div class="emote-grid">
            ${ASCII_EMOTE_LIST.map(
              (item) => `
              <button type="button" class="emote-tile" data-emote="${escapeAttr(item.emote)}" title="${escapeAttr(item.label)}">
                <span class="emote-art">${escapeHtml(item.emote)}</span>
              </button>
            `
            ).join('')}
          </div>
        </div>
      `;
      slot.querySelector('#btn-popover-close')?.addEventListener('click', () => this.closePopovers());
      slot.querySelectorAll('[data-emote]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const emote = btn.getAttribute('data-emote') || '';
          this.insertTextAndFocus(`${emote} `);
        });
      });
      return;
    }

    if (this.plusSubview === 'root') {
      slot.innerHTML = `
        <div class="composer-popover" id="composer-popover">
          <div class="popover-header">
            <span>ACTIONS</span>
            <button type="button" class="small icon-btn" id="btn-popover-close" title="Close" aria-label="Close">${iconClose(16)}</button>
          </div>
          <div class="plus-grid">
            <button type="button" class="plus-tile" data-plus="call">
              ${iconPhone(18)}
              <span class="plus-title">CALL</span>
            </button>
            <button type="button" class="plus-tile" data-plus="voice">
              ${iconMic(18)}
              <span class="plus-title">VOICE</span>
            </button>
            <button type="button" class="plus-tile" data-plus="file">
              ${iconPaperclip(18)}
              <span class="plus-title">FILE</span>
            </button>
            <button type="button" class="plus-tile" data-plus="games">
              ${iconGamepad(18)}
              <span class="plus-title">GAME</span>
            </button>
          </div>
        </div>
      `;
      slot.querySelector('#btn-popover-close')?.addEventListener('click', () => this.closePopovers());
      slot.querySelectorAll('[data-plus]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.getAttribute('data-plus');
          if (act === 'call') {
            this.closePopovers();
            this.callbacks.onStartCall(false);
          } else if (act === 'voice') {
            if (this.callbacks.isInCall()) {
              this.closePopovers();
              this.callbacks.onToast('Finish your active call before recording a voice note.');
              return;
            }
            void this.beginVoiceRecording();
          } else if (act === 'file') {
            (this.root.querySelector('#file-pick-any') as HTMLInputElement | null)?.click();
          } else if (act === 'games') {
            this.plusSubview = 'games';
            this.renderPopoverDOM();
          }
        });
      });
      return;
    }

    if (this.plusSubview === 'games') {
      slot.innerHTML = `
        <div class="composer-popover" id="composer-popover">
          <div class="popover-header">
            <button type="button" class="small icon-btn" id="btn-plus-back" title="Back" aria-label="Back">${iconArrowLeft(16)}</button>
            <span>GAMES</span>
            <button type="button" class="small icon-btn" id="btn-popover-close" title="Close" aria-label="Close">${iconClose(16)}</button>
          </div>
          <div class="games-hub">
            <div class="games-row-instant">
              <div class="game-card">
                <div class="game-card-head">🪙 COIN</div>
                <div class="game-seg-row">
                  <button type="button" class="small" data-cmd="/coin">FLIP</button>
                </div>
              </div>
              <div class="game-card">
                <div class="game-card-head">🎲 DICE</div>
                <div class="game-seg-row">
                  <button type="button" class="small" data-cmd="/roll 6">1–6</button>
                  <button type="button" class="small" data-cmd="/roll 10">1–10</button>
                  <button type="button" class="small" data-cmd="/roll 100">1–100</button>
                </div>
              </div>
              <div class="game-card">
                <div class="game-card-head">✊ RPS</div>
                <div class="game-seg-row rps-row">
                  <button type="button" class="small" data-cmd="/rps rock" title="Rock" aria-label="Rock">✊</button>
                  <button type="button" class="small" data-cmd="/rps paper" title="Paper" aria-label="Paper">✋</button>
                  <button type="button" class="small" data-cmd="/rps scissors" title="Scissors" aria-label="Scissors">✌️</button>
                  <button type="button" class="small" data-cmd="/rps" title="Random" aria-label="Random RPS">🎲</button>
                </div>
              </div>
            </div>
            <div class="games-row-inputs">
              <div class="game-card">
                <div class="game-card-head">🎯 PICK</div>
                <div class="game-input-row">
                  <input type="text" id="game-pick-input" placeholder="Option A, Option B, ..." autocomplete="off" />
                  <button type="button" class="small primary" id="btn-game-pick-go">GO</button>
                </div>
              </div>
              <div class="game-card">
                <div class="game-card-head">🎱 8-BALL</div>
                <div class="game-input-row">
                  <input type="text" id="game-8ball-input" placeholder="Ask a question..." autocomplete="off" />
                  <button type="button" class="small primary" id="btn-game-8ball-go">ASK</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
      slot.querySelector('#btn-plus-back')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.plusSubview = 'root';
        this.renderPopoverDOM();
      });
      slot.querySelector('#btn-popover-close')?.addEventListener('click', () => this.closePopovers());
      slot.querySelectorAll('[data-cmd]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const cmd = btn.getAttribute('data-cmd') || '';
          this.closePopovers();
          if (cmd) this.callbacks.onRunQuickCommand(cmd);
        });
      });

      const pickInput = slot.querySelector('#game-pick-input') as HTMLInputElement | null;
      const runPickFromInput = () => {
        const val = (pickInput?.value || '').trim();
        const items = (val.includes(',') ? val.split(',') : val.split(/\s+/))
          .map((s) => s.trim())
          .filter(Boolean);
        if (items.length < 2) {
          this.callbacks.onToast('Enter at least 2 options (comma or space separated).');
          pickInput?.focus();
          return;
        }
        this.closePopovers();
        this.callbacks.onRunQuickCommand(`/pick ${val}`);
      };
      slot.querySelector('#btn-game-pick-go')?.addEventListener('click', runPickFromInput);
      pickInput?.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.isComposing || ke.keyCode === 229) return;
        if (ke.key === 'Enter') {
          e.preventDefault();
          runPickFromInput();
        }
      });

      const eightInput = slot.querySelector('#game-8ball-input') as HTMLInputElement | null;
      const runEightBallFromInput = () => {
        const val = (eightInput?.value || '').trim();
        if (!val) {
          this.callbacks.onToast('Type a question for the 8-Ball.');
          eightInput?.focus();
          return;
        }
        this.closePopovers();
        this.callbacks.onRunQuickCommand(`/8ball ${val}`);
      };
      slot.querySelector('#btn-game-8ball-go')?.addEventListener('click', runEightBallFromInput);
      eightInput?.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.isComposing || ke.keyCode === 229) return;
        if (ke.key === 'Enter') {
          e.preventDefault();
          runEightBallFromInput();
        }
      });
    }
  }

  private async beginVoiceRecording(): Promise<void> {
    this.voiceSeconds = 0;
    this.popoverMode = 'voice';
    this.renderPopoverDOM();

    try {
      await this.voiceRecorder.start(
        (sec) => {
          this.voiceSeconds = sec;
          const timerEl = this.root.querySelector('#voice-rec-timer');
          if (timerEl) timerEl.textContent = `${formatDuration(sec)} / ${formatDuration(MAX_VOICE_SECONDS)}`;
        },
        (autoResult) => {
          this.popoverMode = 'none';
          this.renderPopoverDOM();
          if (autoResult && autoResult.blob.size > 0) {
            this.callbacks.onSendVoice(
              autoResult.blob,
              autoResult.mimeType,
              autoResult.durationSec
            );
          }
        }
      );
    } catch (err: any) {
      this.popoverMode = 'none';
      this.renderPopoverDOM();
      this.callbacks.onToast(err?.message || 'Microphone access denied.');
    }
  }
}
