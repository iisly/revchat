import { escapeAttr, escapeHtml } from '../markdown';
import { formatDuration } from '../media';
import { PeerInfo, RemoteCallStream } from '../types';
import {
  iconClose,
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
  iconVolumeOff,
  iconVolumeOn,
} from './icons';

export interface CallDockState {
  localStream: MediaStream | null;
  localVideoEnabled: boolean;
  localMuted: boolean;
  isScreenShare: boolean;
  canSwitchCamera: boolean;
  remoteStreams: RemoteCallStream[];
  peers: PeerInfo[];
  peersInCall: PeerInfo[];
  myNickname: string;
}

export interface CallDockCallbacks {
  onJoinCall: () => void;
  onToggleMute: () => void;
  onOutputMuteChange: (muted: boolean) => void;
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
  audioMuted: boolean;
  deafened: boolean;
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
  private lastControlsSig = '';
  private lastChipsSig = '';
  private lastTileLabelsSig = '';
  private lastFullscreenSig: boolean | null = null;
  private lastContainer: HTMLElement | null = null;
  private lastState: CallDockState | null = null;
  private lastCallbacks: CallDockCallbacks | null = null;
  private audioPoolEl: HTMLElement | null = null;
  private uiSlotEl: HTMLElement | null = null;
  private audioEls = new Map<string, HTMLAudioElement>();

  private callAudioMuted = false;
  private callVolume = 1;
  private lastNonZeroVolume = 1;
  private readonly supportsAudioVolume = CallDockController.detectVolumeSupport();
  private lifecycleListenersBound = false;
  private videoTrackCleanups: Array<() => void> = [];
  private selfPreviewStream: MediaStream | null = null;
  private selfPreviewTrackId = '';

  private readonly onVisibilityOrFocus = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.resumeAllMedia();
  };

  private readonly onFullscreenChange = (): void => {
    if (this.uiSlotEl) {
      this.syncFullscreenButtons(this.uiSlotEl);
    }
    this.resumeAllMedia();
  };

  private static detectVolumeSupport(): boolean {
    if (typeof document === 'undefined') return false;
    try {
      const probe = document.createElement('audio');
      probe.volume = 0.5;
      return Math.abs(probe.volume - 0.5) < 0.01;
    } catch {
      return false;
    }
  }

  private bindLifecycleListeners(): void {
    if (this.lifecycleListenersBound) return;
    this.lifecycleListenersBound = true;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityOrFocus);
      document.addEventListener('fullscreenchange', this.onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', this.onFullscreenChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.onVisibilityOrFocus);
      window.addEventListener('pageshow', this.onVisibilityOrFocus);
    }
  }

  private unbindLifecycleListeners(): void {
    if (!this.lifecycleListenersBound) return;
    this.lifecycleListenersBound = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityOrFocus);
      document.removeEventListener('fullscreenchange', this.onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', this.onFullscreenChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.onVisibilityOrFocus);
      window.removeEventListener('pageshow', this.onVisibilityOrFocus);
    }
  }

  private clearVideoTrackCleanups(): void {
    for (const fn of this.videoTrackCleanups) fn();
    this.videoTrackCleanups = [];
  }

  private clearSelfPreviewStream(): void {
    this.selfPreviewStream = null;
    this.selfPreviewTrackId = '';
  }

  private getSelfPreviewStream(localStream: MediaStream): MediaStream {
    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) {
      this.clearSelfPreviewStream();
      return localStream;
    }
    if (!this.selfPreviewStream || this.selfPreviewTrackId !== videoTrack.id) {
      this.selfPreviewTrackId = videoTrack.id;
      this.selfPreviewStream =
        typeof MediaStream !== 'undefined' ? new MediaStream([videoTrack]) : localStream;
    }
    return this.selfPreviewStream;
  }

  private clearVideoElements(slot: HTMLElement | null): void {
    if (!slot) return;
    slot.querySelectorAll('video').forEach((node) => {
      const vid = node as HTMLVideoElement;
      try {
        vid.pause();
        vid.srcObject = null;
      } catch {
        // ignore
      }
    });
  }

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
    this.clearVideoTrackCleanups();
    this.clearVideoElements(this.uiSlotEl);
    this.clearSelfPreviewStream();
    this.callStartedAt = null;
    this.pinnedPeerId = null;
    this.theaterPeerId = null;
    this.autoPinnedScreenId = null;
    this.stageCollapsed = false;
    this.lastRenderKey = '';
    this.lastControlsSig = '';
    this.lastChipsSig = '';
    this.lastTileLabelsSig = '';
    this.lastFullscreenSig = null;
    this.callAudioMuted = false;
    this.callVolume = 1;
    this.lastNonZeroVolume = 1;
  }

  public destroy(): void {
    this.reset();
    this.unbindLifecycleListeners();
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
      this.clearVideoElements(this.uiSlotEl);
      this.lastControlsSig = '';
      this.lastChipsSig = '';
      this.lastTileLabelsSig = '';
      this.lastFullscreenSig = null;
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

  private isAudioOutputMuted(): boolean {
    return this.callAudioMuted || this.callVolume <= 0;
  }

  private getVolumePercent(): number {
    return this.isAudioOutputMuted() ? 0 : Math.round(this.callVolume * 100);
  }

  private applyAudioOutputState(): void {
    const effectiveMuted = this.isAudioOutputMuted();
    for (const el of this.audioEls.values()) {
      el.volume = this.callVolume;
      el.muted = effectiveMuted;
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

    const effectiveMuted = this.isAudioOutputMuted();
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
      if (Math.abs(el.volume - this.callVolume) > 0.001) {
        el.volume = this.callVolume;
      }
      if (el.muted !== effectiveMuted) {
        el.muted = effectiveMuted;
      }
      if (el.paused) {
        void el.play().catch(() => {});
      }
    }
  }

  private resumeAllMedia(): void {
    for (const el of this.audioEls.values()) {
      if (el.paused) {
        void el.play().catch(() => {});
      }
    }
    if (!this.uiSlotEl) return;
    this.uiSlotEl.querySelectorAll('video[data-video-id]').forEach((node) => {
      const vid = node as HTMLVideoElement;
      if (vid.srcObject && vid.paused) {
        vid.muted = true;
        vid.playsInline = true;
        void vid.play().catch(() => {});
      }
    });
  }

  private notifyOutputMuteAndSync(prevMuted: boolean): void {
    const nextMuted = this.isAudioOutputMuted();
    this.applyAudioOutputState();
    if (this.uiSlotEl && this.lastState) {
      this.syncControlsInPlace(this.uiSlotEl, this.lastState);
      this.syncChipsInPlace(this.uiSlotEl, this.lastState);
      this.syncTileLabelsInPlace(this.uiSlotEl, this.buildVideoEntries(this.lastState));
    }
    if (prevMuted !== nextMuted) {
      this.lastCallbacks?.onOutputMuteChange(nextMuted);
    }
  }

  private toggleCallAudioMute(): void {
    const prevMuted = this.isAudioOutputMuted();
    if (prevMuted) {
      this.callAudioMuted = false;
      if (this.callVolume <= 0) {
        this.callVolume = this.lastNonZeroVolume > 0 ? this.lastNonZeroVolume : 1;
      }
    } else {
      if (this.callVolume > 0) {
        this.lastNonZeroVolume = this.callVolume;
      }
      this.callAudioMuted = true;
    }
    this.notifyOutputMuteAndSync(prevMuted);
  }

  private setCallVolume(pct: number): void {
    const prevMuted = this.isAudioOutputMuted();
    const clampedPct = Math.max(0, Math.min(100, Math.round(pct)));
    const nextVol = clampedPct / 100;
    this.callVolume = nextVol;
    if (nextVol > 0) {
      this.lastNonZeroVolume = nextVol;
      this.callAudioMuted = false;
    } else {
      this.callAudioMuted = true;
    }
    this.notifyOutputMuteAndSync(prevMuted);
  }

  private isNativeFullscreen(): boolean {
    if (typeof document === 'undefined') return false;
    return Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement);
  }

  private toggleNativeFullscreen(
    tileEl: HTMLElement | null,
    videoEl: HTMLVideoElement | null
  ): void {
    const doc = document as any;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (doc.webkitFullscreenElement && typeof doc.webkitExitFullscreen === 'function') {
      doc.webkitExitFullscreen();
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

  private syncFullscreenButtons(slot: HTMLElement): void {
    const isFs = this.isNativeFullscreen();
    if (isFs === this.lastFullscreenSig) return;
    this.lastFullscreenSig = isFs;
    const label = isFs ? 'Exit fullscreen' : 'Fullscreen';
    slot.querySelectorAll('[data-fullscreen-tile]').forEach((btn) => {
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label);
      btn.innerHTML = isFs ? iconMinimize(16) : iconMaximize(16);
    });
    const barBtn = slot.querySelector('#btn-call-fullscreen');
    if (barBtn) {
      barBtn.setAttribute('title', label);
      barBtn.setAttribute('aria-label', label);
      barBtn.innerHTML = isFs ? iconMinimize(16) : iconMaximize(16);
    }
  }

  private resolvePeerNickname(peerId: string, fallback: string, state: CallDockState): string {
    return state.peers.find((p) => p.peerId === peerId)?.nickname || fallback;
  }

  private renderTileLabelInner(v: VideoEntry): string {
    const kindIcon = v.isScreenShare ? iconMonitor(12) : iconVideo(12);
    const kindTitle = v.isScreenShare ? 'Screen share' : 'Camera';
    const statusIcons: string[] = [];
    if (v.audioMuted) {
      statusIcons.push(`<span class="tile-status-icon" title="Mic muted">${iconMicOff(11)}</span>`);
    }
    if (v.deafened) {
      statusIcons.push(
        `<span class="tile-status-icon" title="Call audio muted">${iconVolumeOff(11)}</span>`
      );
    }
    return `<span class="tile-kind-icon" title="${kindTitle}">${kindIcon}</span><span class="tile-name">${escapeHtml(v.label)}</span>${statusIcons.join('')}`;
  }

  private getRemoteChipEntries(state: CallDockState): Array<{
    peerId: string;
    nickname: string;
    hasVideo: boolean;
    isScreenShare: boolean;
    audioMuted: boolean;
    deafened: boolean;
  }> {
    const peerById = new Map(state.peers.map((p) => [p.peerId, p]));
    const seen = new Set<string>();
    const list: Array<{
      peerId: string;
      nickname: string;
      hasVideo: boolean;
      isScreenShare: boolean;
      audioMuted: boolean;
      deafened: boolean;
    }> = [];

    for (const rs of state.remoteStreams) {
      seen.add(rs.peerId);
      const peer = peerById.get(rs.peerId);
      list.push({
        peerId: rs.peerId,
        nickname: peer?.nickname || rs.nickname,
        hasVideo: rs.hasVideo,
        isScreenShare: Boolean(rs.isScreenShare),
        audioMuted: Boolean(peer?.audioMuted ?? rs.audioMuted),
        deafened: Boolean(peer?.deafened ?? rs.deafened),
      });
    }

    for (const p of state.peersInCall) {
      if (seen.has(p.peerId)) continue;
      list.push({
        peerId: p.peerId,
        nickname: p.nickname,
        hasVideo: Boolean(p.hasVideo),
        isScreenShare: Boolean(p.isScreenShare),
        audioMuted: Boolean(p.audioMuted),
        deafened: Boolean(p.deafened),
      });
    }

    return list;
  }

  private buildVideoEntries(state: CallDockState): VideoEntry[] {
    if (!state.localStream) return [];
    const peerById = new Map(state.peers.map((p) => [p.peerId, p]));
    const entries: VideoEntry[] = [];
    if (state.localVideoEnabled) {
      entries.push({
        id: 'self',
        label: `${state.myNickname} (You)`,
        isSelf: true,
        isScreenShare: state.isScreenShare,
        audioMuted: state.localMuted,
        deafened: this.isAudioOutputMuted(),
        stream: this.getSelfPreviewStream(state.localStream),
      });
    }
    for (const rs of state.remoteStreams) {
      if (!rs.hasVideo) continue;
      const peer = peerById.get(rs.peerId);
      entries.push({
        id: rs.peerId,
        label: peer?.nickname || rs.nickname,
        isSelf: false,
        isScreenShare: Boolean(rs.isScreenShare),
        audioMuted: Boolean(peer?.audioMuted ?? rs.audioMuted),
        deafened: Boolean(peer?.deafened ?? rs.deafened),
        stream: rs.stream,
      });
    }
    return entries;
  }

  private renderStatusIconsHtml(
    hasVideo: boolean,
    isScreenShare: boolean,
    audioMuted: boolean,
    deafened: boolean
  ): string {
    const icons: string[] = [];
    if (hasVideo) {
      icons.push(
        `<span class="chip-icon" title="${isScreenShare ? 'Sharing screen' : 'Camera on'}">${
          isScreenShare ? iconMonitor(12) : iconVideo(12)
        }</span>`
      );
    }
    if (audioMuted) {
      icons.push(`<span class="chip-icon" title="Mic muted">${iconMicOff(12)}</span>`);
    }
    if (deafened) {
      icons.push(`<span class="chip-icon" title="Call audio muted">${iconVolumeOff(12)}</span>`);
    }
    return icons.join('');
  }

  private renderParticipantChipsHtml(state: CallDockState): string {
    const selfIcons = this.renderStatusIconsHtml(
      state.localVideoEnabled,
      state.isScreenShare,
      state.localMuted,
      this.isAudioOutputMuted()
    );
    const remoteChips = this.getRemoteChipEntries(state).map((r) => {
      const icons = this.renderStatusIconsHtml(
        r.hasVideo,
        r.isScreenShare,
        r.audioMuted,
        r.deafened
      );
      return `<span class="call-chip">${escapeHtml(r.nickname)}${icons}</span>`;
    });

    return [
      `<span class="call-chip self">${escapeHtml(state.myNickname)}${selfIcons}</span>`,
      ...remoteChips,
    ].join('');
  }

  private getControlsSig(state: CallDockState): string {
    return `${state.localMuted ? 1 : 0}:${this.isAudioOutputMuted() ? 1 : 0}:${this.getVolumePercent()}`;
  }

  private getChipsSig(state: CallDockState): string {
    const outputMuted = this.isAudioOutputMuted() ? 1 : 0;
    const remotes = this.getRemoteChipEntries(state)
      .map(
        (r) =>
          `${r.peerId}:${r.nickname}:${r.hasVideo ? 1 : 0}:${r.isScreenShare ? 1 : 0}:${r.audioMuted ? 1 : 0}:${r.deafened ? 1 : 0}`
      )
      .join('|');
    return `${state.myNickname}:${state.localVideoEnabled ? 1 : 0}:${state.isScreenShare ? 1 : 0}:${state.localMuted ? 1 : 0}:${outputMuted};${remotes}`;
  }

  private getTileLabelsSig(videoEntries: VideoEntry[]): string {
    return videoEntries
      .map(
        (v) =>
          `${v.id}:${v.label}:${v.isScreenShare ? 1 : 0}:${v.audioMuted ? 1 : 0}:${v.deafened ? 1 : 0}`
      )
      .join('|');
  }

  private syncControlsInPlace(slot: HTMLElement, state: CallDockState): void {
    const sig = this.getControlsSig(state);
    if (sig === this.lastControlsSig) return;
    this.lastControlsSig = sig;

    const muteBtn = slot.querySelector('#btn-call-mute');
    if (muteBtn) {
      muteBtn.classList.toggle('off', state.localMuted);
      muteBtn.setAttribute('aria-pressed', String(state.localMuted));
      const label = state.localMuted ? 'Unmute mic' : 'Mute mic';
      muteBtn.setAttribute('title', label);
      muteBtn.setAttribute('aria-label', label);
      muteBtn.innerHTML = state.localMuted ? iconMicOff(16) : iconMic(16);
    }

    const speakerMuted = this.isAudioOutputMuted();
    const speakerBtn = slot.querySelector('#btn-call-speaker');
    if (speakerBtn) {
      speakerBtn.classList.toggle('off', speakerMuted);
      speakerBtn.setAttribute('aria-pressed', String(speakerMuted));
      const label = speakerMuted ? 'Unmute call audio' : 'Mute call audio';
      speakerBtn.setAttribute('title', label);
      speakerBtn.setAttribute('aria-label', label);
      speakerBtn.innerHTML = speakerMuted ? iconVolumeOff(16) : iconVolumeOn(16);
    }

    const slider = slot.querySelector('#call-volume-slider') as HTMLInputElement | null;
    if (slider) {
      const pct = this.getVolumePercent();
      if (Number(slider.value) !== pct) {
        slider.value = String(pct);
      }
      slider.style.setProperty('--vol-pct', `${pct}%`);
      slider.setAttribute('title', `Call volume: ${pct}%`);
    }
  }

  private syncChipsInPlace(slot: HTMLElement, state: CallDockState): void {
    const sig = this.getChipsSig(state);
    if (sig === this.lastChipsSig) return;
    this.lastChipsSig = sig;
    const chipsEl = slot.querySelector('.call-chips');
    if (chipsEl) {
      chipsEl.innerHTML = this.renderParticipantChipsHtml(state);
    }
  }

  private syncTileLabelsInPlace(slot: HTMLElement, videoEntries: VideoEntry[]): void {
    const sig = this.getTileLabelsSig(videoEntries);
    if (sig === this.lastTileLabelsSig) return;
    this.lastTileLabelsSig = sig;

    const byId = new Map(videoEntries.map((v) => [v.id, v]));
    slot.querySelectorAll('[data-tile-label-id]').forEach((el) => {
      const id = el.getAttribute('data-tile-label-id') || '';
      const entry = byId.get(id);
      if (entry) {
        el.innerHTML = this.renderTileLabelInner(entry);
      }
    });

    slot.querySelectorAll('[data-switch-focus]').forEach((thumb) => {
      const id = thumb.getAttribute('data-switch-focus') || '';
      const entry = byId.get(id);
      if (entry) {
        thumb.setAttribute('title', `Focus ${entry.label}`);
      }
    });
  }

  private renderTileHtml(v: VideoEntry, extraClass: string, isFocused: boolean): string {
    const safeId = escapeAttr(v.id);
    const isSelfScreen = v.isSelf && v.isScreenShare;
    const isFs = this.isNativeFullscreen();
    const fsLabel = isFs ? 'Exit fullscreen' : 'Fullscreen';
    const title = isSelfScreen
      ? 'Sharing your screen'
      : isFocused
        ? 'Theater view'
        : extraClass.includes('single-tile')
          ? 'Double-click to expand'
          : 'Click to pin • Double-click to expand';
    const toolsHtml = isSelfScreen
      ? ''
      : `
        <div class="call-tile-tools">
          <button
            type="button"
            class="tile-tool-btn"
            data-focus-tile="${safeId}"
            title="${isFocused ? 'Exit theater mode (ESC)' : 'Theater mode'}"
            aria-label="${isFocused ? 'Exit theater mode' : 'Theater mode'}"
          >${isFocused ? iconClose(16) : iconExpand(16)}</button>
          <button
            type="button"
            class="tile-tool-btn"
            data-fullscreen-tile="${safeId}"
            title="${fsLabel}"
            aria-label="${fsLabel}"
          >${isFs ? iconMinimize(16) : iconMaximize(16)}</button>
        </div>
      `;
    return `
      <div class="call-tile ${extraClass}" data-tile-id="${safeId}" title="${title}">
        <video data-video-id="${safeId}" autoplay playsinline muted></video>
        ${toolsHtml}
        <span class="call-tile-label" data-tile-label-id="${safeId}">${this.renderTileLabelInner(v)}</span>
      </div>
    `;
  }

  public render(
    container: HTMLElement | null,
    state: CallDockState,
    callbacks: CallDockCallbacks
  ): void {
    if (!container) return;
    this.bindLifecycleListeners();
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
    } = state;

    this.syncAudioPool(remoteStreams, Boolean(localStream));

    // Passive banner when peers have an active room call and local user hasn't joined
    if (!localStream) {
      this.stopTimer();
      this.clearVideoTrackCleanups();
      this.clearSelfPreviewStream();
      this.callStartedAt = null;
      this.pinnedPeerId = null;
      this.theaterPeerId = null;
      this.autoPinnedScreenId = null;
      this.stageCollapsed = false;
      this.lastControlsSig = '';
      this.lastChipsSig = '';
      this.lastTileLabelsSig = '';
      this.lastFullscreenSig = null;
      this.callAudioMuted = false;
      this.callVolume = 1;
      this.lastNonZeroVolume = 1;

      if (peersInCall.length === 0 && remoteStreams.length === 0) {
        if (this.lastRenderKey !== 'idle' || containerChanged) {
          this.clearVideoElements(slot);
          slot.innerHTML = '';
          this.lastRenderKey = 'idle';
        }
        return;
      }

      const activeNames =
        peersInCall.length > 0
          ? peersInCall.map((p) => p.nickname)
          : remoteStreams.map((r) => this.resolvePeerNickname(r.peerId, r.nickname, state));
      const count = Math.max(peersInCall.length, remoteStreams.length);
      const passiveKey = `passive:${count}:${activeNames.join(',')}`;
      if (passiveKey === this.lastRenderKey && !containerChanged) return;
      this.lastRenderKey = passiveKey;

      this.clearVideoElements(slot);
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
        this.resumeAllMedia();
        callbacks.onJoinCall();
      });
      return;
    }

    // Active call
    const videoEntries = this.buildVideoEntries(state);

    const activeIds = new Set(videoEntries.map((v) => v.id));
    if (this.pinnedPeerId && !activeIds.has(this.pinnedPeerId)) {
      this.pinnedPeerId = null;
    }
    if (
      this.theaterPeerId &&
      (!activeIds.has(this.theaterPeerId) || (this.theaterPeerId === 'self' && isScreenShare))
    ) {
      this.theaterPeerId = null;
    }

    const screenId = remoteStreams.find((r) => r.hasVideo && r.isScreenShare)?.peerId ?? null;
    if (screenId) {
      if (screenId !== this.autoPinnedScreenId) {
        this.autoPinnedScreenId = screenId;
        this.pinnedPeerId = screenId;
      }
    } else {
      this.autoPinnedScreenId = null;
    }

    const hasAnyVideo = videoEntries.length > 0;

    // Exclude mutable display nicknames and mute/volume flags so live updates patch in-place without video flicker
    const renderKey = [
      'active',
      localStream.id,
      localStream
        .getVideoTracks()
        .map((t) => t.id)
        .join(','),
      localVideoEnabled,
      isScreenShare,
      canSwitchCamera,
      this.stageCollapsed,
      this.pinnedPeerId || '',
      this.theaterPeerId || '',
      remoteStreams
        .map(
          (r) =>
            `${r.peerId}:${r.stream.id}:${r.stream
              .getVideoTracks()
              .map((t) => t.id)
              .join(',')}:${r.hasVideo ? 1 : 0}:${r.isScreenShare ? 1 : 0}`
        )
        .join('|'),
    ].join(';');

    this.ensureTimerRunning(slot);
    if (renderKey === this.lastRenderKey && !containerChanged) {
      this.syncControlsInPlace(slot, state);
      this.syncChipsInPlace(slot, state);
      this.syncTileLabelsInPlace(slot, videoEntries);
      this.syncFullscreenButtons(slot);
      this.resumeAllMedia();
      return;
    }
    this.lastRenderKey = renderKey;

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
    const isFs = this.isNativeFullscreen();
    const fsLabel = isFs ? 'Exit fullscreen' : 'Fullscreen';

    const speakerMuted = this.isAudioOutputMuted();
    const volPct = this.getVolumePercent();
    const micLabel = localMuted ? 'Unmute mic' : 'Mute mic';
    const speakerLabel = speakerMuted ? 'Unmute call audio' : 'Mute call audio';
    const camActive = localVideoEnabled && !isScreenShare;
    const camLabel = camActive ? 'Turn camera off' : 'Turn camera on';
    const screenLabel = isScreenShare ? 'Stop sharing' : 'Share screen';
    const collapseLabel = this.stageCollapsed ? 'Show video' : 'Hide video';

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
              .map((v) => {
                const safeThumbId = escapeAttr(v.id);
                const thumbFocusAttr =
                  v.isSelf && v.isScreenShare
                    ? `title="${escapeAttr(v.label)}"`
                    : `data-switch-focus="${safeThumbId}" title="Focus ${escapeAttr(v.label)}"`;
                return `
                  <div class="call-thumb" ${thumbFocusAttr}>
                    <video data-video-id="${safeThumbId}" autoplay playsinline muted></video>
                    <span class="call-tile-label" data-tile-label-id="${safeThumbId}">${this.renderTileLabelInner(v)}</span>
                  </div>
                `;
              })
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

    const speakerControlHtml = `
      <button
        type="button"
        class="call-ctrl-btn ${speakerMuted ? 'off' : ''}"
        id="btn-call-speaker"
        title="${speakerLabel}"
        aria-label="${speakerLabel}"
        aria-pressed="${speakerMuted}"
      >${speakerMuted ? iconVolumeOff(16) : iconVolumeOn(16)}</button>
    `;

    const audioOutputGroupHtml = this.supportsAudioVolume
      ? `
        <div class="call-volume-group">
          ${speakerControlHtml}
          <input
            type="range"
            class="call-volume-slider"
            id="call-volume-slider"
            min="0"
            max="100"
            value="${volPct}"
            style="--vol-pct:${volPct}%"
            aria-label="Call volume"
            title="Call volume: ${volPct}%"
          />
        </div>
      `
      : speakerControlHtml;

    this.clearVideoElements(slot);
    slot.innerHTML = `
      <div class="call-dock ${isTheater ? 'theater' : ''}">
        ${stageHtml}
        <div class="call-strip">
          <div class="call-strip-left">
            <span class="call-live-pill">
              <span class="call-pulse"></span>
              <code class="call-timer" id="call-timer">${elapsedStr}</code>
            </span>
            <div class="call-chips">${this.renderParticipantChipsHtml(state)}</div>
          </div>
          <div class="call-strip-controls">
            <button
              type="button"
              class="call-ctrl-btn ${localMuted ? 'off' : ''}"
              id="btn-call-mute"
              title="${micLabel}"
              aria-label="${micLabel}"
              aria-pressed="${localMuted}"
            >${localMuted ? iconMicOff(16) : iconMic(16)}</button>
            ${audioOutputGroupHtml}
            <button
              type="button"
              class="call-ctrl-btn ${camActive ? 'active' : ''}"
              id="btn-call-cam"
              title="${camLabel}"
              aria-label="${camLabel}"
              aria-pressed="${camActive}"
            >${camActive ? iconVideo(16) : iconVideoOff(16)}</button>
            ${
              canFlipCam
                ? `<button type="button" class="call-ctrl-btn" id="btn-call-flip" title="Switch camera" aria-label="Switch camera">${iconRefresh(16)}</button>`
                : ''
            }
            ${
              canScreen
                ? `<button type="button" class="call-ctrl-btn ${isScreenShare ? 'active' : ''}" id="btn-call-screen" title="${screenLabel}" aria-label="${screenLabel}" aria-pressed="${isScreenShare}">${iconMonitor(16)}</button>`
                : ''
            }
            ${
              isTheater
                ? `
              <button type="button" class="call-ctrl-btn" id="btn-call-fullscreen" title="${fsLabel}" aria-label="${fsLabel}">${isFs ? iconMinimize(16) : iconMaximize(16)}</button>
              <button type="button" class="call-ctrl-btn" id="btn-call-exit-theater" title="Exit theater mode" aria-label="Exit theater mode">${iconClose(16)}</button>
            `
                : hasAnyVideo
                ? `<button type="button" class="call-ctrl-btn" id="btn-call-collapse" title="${collapseLabel}" aria-label="${collapseLabel}" aria-pressed="${this.stageCollapsed}">${
                    this.stageCollapsed ? iconEye(16) : iconEyeOff(16)
                  }</button>`
                : ''
            }
            <button
              type="button"
              class="call-ctrl-btn leave"
              id="btn-call-leave"
              title="Leave call"
              aria-label="Leave call"
            >${iconPhoneOff(16)}</button>
          </div>
        </div>
      </div>
    `;

    // Bind MediaStreams directly to video elements
    this.lastControlsSig = this.getControlsSig(state);
    this.lastChipsSig = this.getChipsSig(state);
    this.lastTileLabelsSig = this.getTileLabelsSig(videoEntries);
    this.lastFullscreenSig = isFs;
    this.clearVideoTrackCleanups();
    const streamById = new Map(videoEntries.map((v) => [v.id, v.stream]));
    slot.querySelectorAll('video[data-video-id]').forEach((node) => {
      const vid = node as HTMLVideoElement;
      const id = vid.getAttribute('data-video-id') || '';
      const stream = streamById.get(id);
      if (!stream) return;

      vid.muted = true;
      vid.playsInline = true;
      vid.autoplay = true;
      vid.srcObject = stream;
      void vid.play().catch(() => {});

      const onWebkitEndFs = () => {
        this.resumeAllMedia();
      };
      vid.addEventListener('webkitendfullscreen', onWebkitEndFs);
      this.videoTrackCleanups.push(() => {
        vid.removeEventListener('webkitendfullscreen', onWebkitEndFs);
      });

      for (const track of stream.getVideoTracks()) {
        const onTrackUnmute = () => {
          if (vid.paused) {
            vid.muted = true;
            vid.playsInline = true;
            void vid.play().catch(() => {});
          }
        };
        track.addEventListener('unmute', onTrackUnmute);
        this.videoTrackCleanups.push(() => {
          track.removeEventListener('unmute', onTrackUnmute);
        });
      }
    });

    slot.querySelectorAll('[data-focus-tile]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.resumeAllMedia();
        const id = btn.getAttribute('data-focus-tile') || '';
        this.theaterPeerId = this.theaterPeerId === id ? null : id;
        this.lastRenderKey = '';
        this.render(container, state, callbacks);
      });
    });

    slot.querySelectorAll('[data-fullscreen-tile]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.resumeAllMedia();
        const tileEl = (btn as HTMLElement).closest('.call-tile') as HTMLElement | null;
        const vidEl = tileEl?.querySelector('video') as HTMLVideoElement | null;
        this.toggleNativeFullscreen(tileEl, vidEl);
      });
    });

    slot.querySelectorAll('[data-switch-focus]').forEach((thumb) => {
      thumb.addEventListener('click', () => {
        this.resumeAllMedia();
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
          if (this.isNativeFullscreen()) return;
          if ((e.target as HTMLElement | null)?.closest('.tile-tool-btn')) {
            return;
          }
          if (videoEntries.length <= 1) return;
          const pid = tile.getAttribute('data-tile-id') || '';
          this.pinnedPeerId = this.pinnedPeerId === pid ? null : pid;
          this.lastRenderKey = '';
          this.render(container, state, callbacks);
        });
        tile.addEventListener('dblclick', (e) => {
          if (this.isNativeFullscreen()) return;
          if ((e.target as HTMLElement | null)?.closest('.tile-tool-btn')) {
            return;
          }
          const pid = tile.getAttribute('data-tile-id') || '';
          if (!pid || (pid === 'self' && isScreenShare)) return;
          this.resumeAllMedia();
          this.theaterPeerId = pid;
          this.lastRenderKey = '';
          this.render(container, state, callbacks);
        });
      });
    }

    slot.querySelector('#btn-call-mute')?.addEventListener('click', () => {
      this.resumeAllMedia();
      callbacks.onToggleMute();
    });
    slot.querySelector('#btn-call-speaker')?.addEventListener('click', () => {
      this.resumeAllMedia();
      this.toggleCallAudioMute();
    });
    const volSlider = slot.querySelector('#call-volume-slider') as HTMLInputElement | null;
    volSlider?.addEventListener('input', () => {
      this.resumeAllMedia();
      this.setCallVolume(Number(volSlider.value));
    });
    slot.querySelector('#btn-call-cam')?.addEventListener('click', () => {
      this.resumeAllMedia();
      this.stageCollapsed = false;
      callbacks.onToggleVideo();
    });
    slot.querySelector('#btn-call-flip')?.addEventListener('click', () => {
      this.resumeAllMedia();
      callbacks.onSwitchCamera();
    });
    slot.querySelector('#btn-call-screen')?.addEventListener('click', () => {
      this.resumeAllMedia();
      this.stageCollapsed = false;
      callbacks.onToggleScreenShare();
    });
    slot.querySelector('#btn-call-fullscreen')?.addEventListener('click', () => {
      this.resumeAllMedia();
      const tileEl = slot.querySelector('.call-theater-main .call-tile') as HTMLElement | null;
      const vidEl = tileEl?.querySelector('video') as HTMLVideoElement | null;
      this.toggleNativeFullscreen(tileEl, vidEl);
    });
    slot.querySelector('#btn-call-exit-theater')?.addEventListener('click', () => {
      this.resumeAllMedia();
      this.exitTheaterIfActive();
    });
    slot.querySelector('#btn-call-collapse')?.addEventListener('click', () => {
      this.resumeAllMedia();
      this.theaterPeerId = null;
      this.stageCollapsed = !this.stageCollapsed;
      this.render(container, state, callbacks);
    });
    slot.querySelector('#btn-call-leave')?.addEventListener('click', () => callbacks.onLeaveCall());
  }
}
