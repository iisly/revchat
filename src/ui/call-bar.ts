import { escapeAttr, escapeHtml } from '../markdown';
import { formatDuration } from '../media';
import { PeerInfo, RemoteCallStream } from '../types';
import {
  iconExpand,
  iconEye,
  iconEyeOff,
  iconMaximize,
  iconMic,
  iconMicOff,
  iconMinimize,
  iconMonitor,
  iconPhone,
  iconPhoneOff,
  iconRefresh,
  iconVideo,
  iconVideoOff,
} from './icons';

export interface CallDockState {
  localStream: MediaStream | null;
  localVideoEnabled: boolean;
  localMuted: boolean;
  isScreenShare: boolean;
  canSwitchCamera: boolean;
  remoteStreams: RemoteCallStream[];
  peersInCall: PeerInfo[];
  myNickname: string;
}

export interface CallDockCallbacks {
  onJoinCall: () => void;
  onToggleMute: () => void;
  onToggleVideo: () => void;
  onSwitchCamera: () => void;
  onToggleScreenShare: () => void;
  onLeaveCall: () => void;
}

interface VideoEntry {
  id: string;
  label: string;
  isSelf: boolean;
  isScreenShare: boolean;
  stream: MediaStream;
}

export class CallDockController {
  private callStartedAt: number | null = null;
  private timerId: number | null = null;
  private pinnedPeerId: string | null = null;
  private theaterPeerId: string | null = null;
  private autoPinnedScreenId: string | null = null;
  private stageCollapsed = false;
  private lastRenderKey = '';
  private lastContainer: HTMLElement | null = null;
  private lastState: CallDockState | null = null;
  private lastCallbacks: CallDockCallbacks | null = null;
  private audioPoolEl: HTMLElement | null = null;
  private uiSlotEl: HTMLElement | null = null;
  private audioEls = new Map<string, HTMLAudioElement>();
  private lastMutedState = false;

  private clearAudioPool(): void {
    for (const el of this.audioEls.values()) {
      el.srcObject = null;
      el.remove();
    }
    this.audioEls.clear();
  }

  public reset(): void {
    this.stopTimer();
    this.clearAudioPool();
    this.callStartedAt = null;
    this.pinnedPeerId = null;
    this.theaterPeerId = null;
    this.autoPinnedScreenId = null;
    this.stageCollapsed = false;
    this.lastRenderKey = '';
    this.lastMutedState = false;
  }

  public destroy(): void {
    this.reset();
    this.uiSlotEl = null;
    this.audioPoolEl = null;
    this.lastContainer = null;
    this.lastState = null;
    this.lastCallbacks = null;
  }

  public exitTheaterIfActive(): boolean {
    if (this.theaterPeerId === null) return false;
    this.theaterPeerId = null;
    this.lastRenderKey = '';
    if (this.lastContainer && this.lastState && this.lastCallbacks) {
      this.render(this.lastContainer, this.lastState, this.lastCallbacks);
    }
    return true;
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private ensureTimerRunning(slot: HTMLElement): void {
    if (this.callStartedAt === null) {
      this.callStartedAt = Date.now();
    }
    if (this.timerId !== null) return;
    this.timerId = window.setInterval(() => {
      if (this.callStartedAt === null) return;
      const el = slot.querySelector('#call-timer');
      if (el) {
        el.textContent = formatDuration(Math.floor((Date.now() - this.callStartedAt) / 1000));
      }
    }, 1000);
  }

  private ensureSlots(container: HTMLElement): void {
    if (
      !this.uiSlotEl ||
      !this.audioPoolEl ||
      this.uiSlotEl.parentElement !== container ||
      this.audioPoolEl.parentElement !== container
    ) {
      this.clearAudioPool();
      container.innerHTML = '';
      this.uiSlotEl = document.createElement('div');
      this.uiSlotEl.className = 'call-ui-slot';
      this.audioPoolEl = document.createElement('div');
      this.audioPoolEl.className = 'call-audio-pool';
      this.audioPoolEl.setAttribute('aria-hidden', 'true');
      container.appendChild(this.uiSlotEl);
      container.appendChild(this.audioPoolEl);
    }
  }

  private syncAudioPool(remoteStreams: RemoteCallStream[], activeCall: boolean): void {
    if (!this.audioPoolEl) return;
    if (!activeCall) {
      this.clearAudioPool();
      return;
    }

    const activeIds = new Set(remoteStreams.map((r) => r.peerId));
    for (const [peerId, el] of this.audioEls.entries()) {
      if (!activeIds.has(peerId)) {
        el.srcObject = null;
        el.remove();
        this.audioEls.delete(peerId);
      }
    }

    for (const rs of remoteStreams) {
      let el = this.audioEls.get(rs.peerId);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        (el as any).playsInline = true;
        this.audioEls.set(rs.peerId, el);
        this.audioPoolEl.appendChild(el);
      }
      if (el.srcObject !== rs.stream) {
        el.srcObject = rs.stream;
      }
      if (el.paused) {
        void el.play().catch(() => {});
      }
    }
  }

  private resumeAllAudio(): void {
    for (const el of this.audioEls.values()) {
      if (el.paused) {
        void el.play().catch(() => {});
      }
    }
  }

  private toggleNativeFullscreen(
    tileEl: HTMLElement | null,
    videoEl: HTMLVideoElement | null
  ): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (tileEl?.requestFullscreen) {
      void tileEl.requestFullscreen().catch(() => {});
      return;
    }
    const anyTile = tileEl as any;
    if (anyTile?.webkitRequestFullscreen) {
      anyTile.webkitRequestFullscreen();
      return;
    }
    const anyVid = videoEl as any;
    if (anyVid?.webkitEnterFullscreen) {
      anyVid.webkitEnterFullscreen();
    }
  }

  private renderTileHtml(v: VideoEntry, extraClass: string, isFocused: boolean): string {
    const safeId = escapeAttr(v.id);
    const title = isFocused
      ? 'Theater focus'
      : extraClass.includes('single-tile')
        ? 'Double-click to expand'
        : 'Click to pin • Double-click to expand';
    return `
      <div class="call-tile ${extraClass}" data-tile-id="${safeId}" title="${title}">
        <video data-video-id="${safeId}" autoplay playsinline muted></video>
        <div class="call-tile-tools">
          <button
            type="button"
            class="tile-tool-btn"
            data-focus-tile="${safeId}"
            title="${isFocused ? 'Exit Theater Mode (ESC)' : 'Expand View'}"
            aria-label="${isFocused ? 'Exit Theater Mode' : 'Expand View'}"
          >${isFocused ? iconMinimize(14) : iconExpand(14)}</button>
          <button
            type="button"
            class="tile-tool-btn"
            data-fullscreen-tile="${safeId}"
            title="Fullscreen"
            aria-label="Fullscreen"
          >${iconMaximize(14)}</button>
        </div>
        <span class="call-tile-label">${escapeHtml(v.label)}</span>
      </div>
    `;
  }

  public render(
    container: HTMLElement | null,
    state: CallDockState,
    callbacks: CallDockCallbacks
  ): void {
    if (!container) return;
    const containerChanged = this.lastContainer !== container;
    this.lastContainer = container;
    this.lastState = state;
    this.lastCallbacks = callbacks;
    this.ensureSlots(container);
    const slot = this.uiSlotEl!;

    const {
      localStream,
      localVideoEnabled,
      localMuted,
      isScreenShare,
      canSwitchCamera,
      remoteStreams,
      peersInCall,
      myNickname,
    } = state;

    this.syncAudioPool(remoteStreams, Boolean(localStream));

    // Passive banner when peers have an active room call and local user hasn't joined
    if (!localStream) {
      this.stopTimer();
      this.callStartedAt = null;
      this.pinnedPeerId = null;
      this.theaterPeerId = null;
      this.autoPinnedScreenId = null;
      this.stageCollapsed = false;
      this.lastMutedState = false;

      if (peersInCall.length === 0 && remoteStreams.length === 0) {
        if (this.lastRenderKey !== 'idle' || containerChanged) {
          slot.innerHTML = '';
          this.lastRenderKey = 'idle';
        }
        return;
      }

      const activeNames =
        peersInCall.length > 0
          ? peersInCall.map((p) => p.nickname)
          : remoteStreams.map((r) => r.nickname);
      const count = Math.max(peersInCall.length, remoteStreams.length);
      const passiveKey = `passive:${count}:${activeNames.join(',')}`;
      if (passiveKey === this.lastRenderKey && !containerChanged) return;
      this.lastRenderKey = passiveKey;

      slot.innerHTML = `
        <div class="call-banner">
          <div class="call-banner-info">
            <span class="call-pulse"></span>
            ${iconPhone(14)}
            <b>CALL ACTIVE (${count})</b>
            <span class="call-banner-peers">${escapeHtml(activeNames.join(', '))}</span>
          </div>
          <button type="button" class="small primary" id="btn-join-call">JOIN</button>
        </div>
      `;
      slot.querySelector('#btn-join-call')?.addEventListener('click', () => {
        this.resumeAllAudio();
        callbacks.onJoinCall();
      });
      return;
    }

    // Active call
    const videoEntries: VideoEntry[] = [];
    if (localVideoEnabled) {
      videoEntries.push({
        id: 'self',
        label: `${myNickname} (You)${isScreenShare ? ' • SCREEN' : ''}`,
        isSelf: true,
        isScreenShare,
        stream: localStream,
      });
    }
    for (const rs of remoteStreams) {
      if (!rs.hasVideo) continue;
      videoEntries.push({
        id: rs.peerId,
        label: `${rs.nickname}${rs.isScreenShare ? ' • SCREEN' : ''}`,
        isSelf: false,
        isScreenShare: Boolean(rs.isScreenShare),
        stream: rs.stream,
      });
    }

    const activeIds = new Set(videoEntries.map((v) => v.id));
    if (this.pinnedPeerId && !activeIds.has(this.pinnedPeerId)) {
      this.pinnedPeerId = null;
    }
    if (this.theaterPeerId && !activeIds.has(this.theaterPeerId)) {
      this.theaterPeerId = null;
    }

    const screenId =
      remoteStreams.find((r) => r.hasVideo && r.isScreenShare)?.peerId ??
      (localVideoEnabled && isScreenShare ? 'self' : null);
    if (screenId) {
      if (screenId !== this.autoPinnedScreenId) {
        this.autoPinnedScreenId = screenId;
        this.pinnedPeerId = screenId;
      }
    } else {
      this.autoPinnedScreenId = null;
    }

    const hasAnyVideo = videoEntries.length > 0;

    const renderKey = [
      'active',
      localStream.id,
      myNickname,
      localVideoEnabled,
      isScreenShare,
      canSwitchCamera,
      this.stageCollapsed,
      this.pinnedPeerId || '',
      this.theaterPeerId || '',
      remoteStreams
        .map(
          (r) =>
            `${r.peerId}:${r.nickname}:${r.stream.id}:${r.hasVideo ? 1 : 0}:${r.isScreenShare ? 1 : 0}`
        )
        .join('|'),
    ].join(';');

    this.ensureTimerRunning(slot);
    if (renderKey === this.lastRenderKey && !containerChanged) {
      if (this.lastMutedState !== localMuted) {
        this.lastMutedState = localMuted;
        const muteBtn = slot.querySelector('#btn-call-mute');
        if (muteBtn) {
          muteBtn.classList.toggle('danger', localMuted);
          muteBtn.innerHTML = `${localMuted ? iconMicOff(14) : iconMic(14)}<span>${localMuted ? 'MUTED' : 'MIC'}</span>`;
        }
        const selfChip = slot.querySelector('.call-chip.self');
        if (selfChip) {
          selfChip.textContent = `${myNickname}${localMuted ? ' (MUTED)' : ''}`;
        }
      }
      return;
    }
    this.lastRenderKey = renderKey;
    this.lastMutedState = localMuted;

    const elapsedStr =
      this.callStartedAt !== null
        ? formatDuration(Math.floor((Date.now() - this.callStartedAt) / 1000))
        : '00:00';
    const canScreen = Boolean(navigator.mediaDevices?.getDisplayMedia);
    const canFlipCam = localVideoEnabled && !isScreenShare && canSwitchCamera;
    const focusedEntry = this.theaterPeerId
      ? videoEntries.find((v) => v.id === this.theaterPeerId) || null
      : null;
    const isTheater = Boolean(focusedEntry);
    const showStage = hasAnyVideo && !this.stageCollapsed && !isTheater;

    const participantChips = [
      `<span class="call-chip self">${escapeHtml(myNickname)}${localMuted ? ' (MUTED)' : ''}</span>`,
      ...remoteStreams.map(
        (rs) =>
          `<span class="call-chip">${escapeHtml(rs.nickname)}${rs.isScreenShare ? ' • SCREEN' : rs.hasVideo ? ' • CAM' : ''}</span>`
      ),
    ].join('');

    let stageHtml = '';
    if (isTheater && focusedEntry) {
      const otherEntries = videoEntries.filter((v) => v.id !== focusedEntry.id);
      const focusCls = `${focusedEntry.isSelf ? 'self' : ''} ${focusedEntry.isScreenShare ? 'screen-tile' : ''}`.trim();
      stageHtml = `
        <div class="call-theater-main">
          ${this.renderTileHtml(focusedEntry, focusCls, true)}
        </div>
        ${
          otherEntries.length > 0
            ? `
          <div class="call-thumbs">
            ${otherEntries
              .map(
                (v) => `
              <div class="call-thumb" data-switch-focus="${escapeAttr(v.id)}" title="Click to focus ${escapeAttr(v.label)}">
                <video data-video-id="${escapeAttr(v.id)}" autoplay playsinline muted></video>
                <span class="call-tile-label">${escapeHtml(v.label)}</span>
              </div>
            `
              )
              .join('')}
          </div>
        `
            : ''
        }
      `;
    } else if (showStage) {
      stageHtml = `
        <div class="call-stage ${this.pinnedPeerId ? 'has-pinned' : ''}" id="call-stage">
          ${videoEntries
            .map((v) => {
              const cls = [
                v.isSelf ? 'self' : '',
                v.isScreenShare ? 'screen-tile' : '',
                videoEntries.length === 1 ? 'single-tile' : this.pinnedPeerId === v.id ? 'pinned' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return this.renderTileHtml(v, cls, false);
            })
            .join('')}
        </div>
      `;
    }

    slot.innerHTML = `
      <div class="call-dock ${isTheater ? 'theater' : ''}">
        ${stageHtml}
        <div class="call-strip">
          <div class="call-strip-left">
            <span class="call-pulse"></span>
            ${iconPhone(14)}
            <span class="call-title">CALL</span>
            <code class="call-timer" id="call-timer">${elapsedStr}</code>
            <div class="call-chips">${participantChips}</div>
          </div>
          <div class="call-strip-controls">
            <button type="button" class="small ${localMuted ? 'danger' : ''}" id="btn-call-mute">
              ${localMuted ? iconMicOff(14) : iconMic(14)}<span>${localMuted ? 'MUTED' : 'MIC'}</span>
            </button>
            <button type="button" class="small ${localVideoEnabled && !isScreenShare ? 'primary' : ''}" id="btn-call-cam">
              ${localVideoEnabled && !isScreenShare ? iconVideo(14) : iconVideoOff(14)}<span>CAM</span>
            </button>
            ${canFlipCam ? `<button type="button" class="small" id="btn-call-flip">${iconRefresh(14)}<span>FLIP</span></button>` : ''}
            ${
              canScreen
                ? `<button type="button" class="small ${isScreenShare ? 'primary' : ''}" id="btn-call-screen">${iconMonitor(14)}<span>SCREEN</span></button>`
                : ''
            }
            ${
              isTheater
                ? `
              <button type="button" class="small" id="btn-call-fullscreen">${iconMaximize(14)}<span>FULLSCREEN</span></button>
              <button type="button" class="small" id="btn-call-exit-theater">${iconMinimize(14)}<span>EXIT</span></button>
            `
                : hasAnyVideo
                ? `<button type="button" class="small" id="btn-call-collapse">${
                    this.stageCollapsed ? `${iconEye(14)}<span>VIDEO</span>` : `${iconEyeOff(14)}<span>HIDE</span>`
                  }</button>`
                : ''
            }
            <button type="button" class="small danger" id="btn-call-leave">${iconPhoneOff(14)}<span>LEAVE</span></button>
          </div>
        </div>
      </div>
    `;

    // Bind MediaStreams directly to video elements
    const streamById = new Map(videoEntries.map((v) => [v.id, v.stream]));
    slot.querySelectorAll('video[data-video-id]').forEach((node) => {
      const vid = node as HTMLVideoElement;
      const id = vid.getAttribute('data-video-id') || '';
      const stream = streamById.get(id);
      if (stream) {
        vid.srcObject = stream;
        void vid.play().catch(() => {});
      }
    });

    slot.querySelectorAll('[data-focus-tile]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.resumeAllAudio();
        const id = btn.getAttribute('data-focus-tile') || '';
        this.theaterPeerId = this.theaterPeerId === id ? null : id;
        this.lastRenderKey = '';
        this.render(container, state, callbacks);
      });
    });

    slot.querySelectorAll('[data-fullscreen-tile]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.resumeAllAudio();
        const tileEl = (btn as HTMLElement).closest('.call-tile') as HTMLElement | null;
        const vidEl = tileEl?.querySelector('video') as HTMLVideoElement | null;
        this.toggleNativeFullscreen(tileEl, vidEl);
      });
    });

    slot.querySelectorAll('[data-switch-focus]').forEach((thumb) => {
      thumb.addEventListener('click', () => {
        this.resumeAllAudio();
        const id = thumb.getAttribute('data-switch-focus') || '';
        if (id) {
          this.theaterPeerId = id;
          this.lastRenderKey = '';
          this.render(container, state, callbacks);
        }
      });
    });

    if (!isTheater) {
      slot.querySelectorAll('[data-tile-id]').forEach((tile) => {
        tile.addEventListener('click', (e) => {
          if ((e.target as HTMLElement | null)?.closest('.tile-tool-btn')) return;
          if (videoEntries.length <= 1) return;
          const pid = tile.getAttribute('data-tile-id') || '';
          this.pinnedPeerId = this.pinnedPeerId === pid ? null : pid;
          this.lastRenderKey = '';
          this.render(container, state, callbacks);
        });
        tile.addEventListener('dblclick', (e) => {
          if ((e.target as HTMLElement | null)?.closest('.tile-tool-btn')) return;
          this.resumeAllAudio();
          const pid = tile.getAttribute('data-tile-id') || '';
          if (pid) {
            this.theaterPeerId = pid;
            this.lastRenderKey = '';
            this.render(container, state, callbacks);
          }
        });
      });
    }

    slot.querySelector('#btn-call-mute')?.addEventListener('click', () => {
      this.resumeAllAudio();
      callbacks.onToggleMute();
    });
    slot.querySelector('#btn-call-cam')?.addEventListener('click', () => {
      this.resumeAllAudio();
      this.stageCollapsed = false;
      callbacks.onToggleVideo();
    });
    slot.querySelector('#btn-call-flip')?.addEventListener('click', () => {
      this.resumeAllAudio();
      callbacks.onSwitchCamera();
    });
    slot.querySelector('#btn-call-screen')?.addEventListener('click', () => {
      this.resumeAllAudio();
      this.stageCollapsed = false;
      callbacks.onToggleScreenShare();
    });
    slot.querySelector('#btn-call-fullscreen')?.addEventListener('click', () => {
      this.resumeAllAudio();
      const tileEl = slot.querySelector('.call-theater-main .call-tile') as HTMLElement | null;
      const vidEl = tileEl?.querySelector('video') as HTMLVideoElement | null;
      this.toggleNativeFullscreen(tileEl, vidEl);
    });
    slot.querySelector('#btn-call-exit-theater')?.addEventListener('click', () => {
      this.resumeAllAudio();
      this.exitTheaterIfActive();
    });
    slot.querySelector('#btn-call-collapse')?.addEventListener('click', () => {
      this.resumeAllAudio();
      this.theaterPeerId = null;
      this.stageCollapsed = !this.stageCollapsed;
      this.render(container, state, callbacks);
    });
    slot.querySelector('#btn-call-leave')?.addEventListener('click', () => callbacks.onLeaveCall());
  }
}
