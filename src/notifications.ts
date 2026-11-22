const BADGE_FAVICON_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="120" fill="#141617"/>
    <defs>
      <mask id="r-cut-unread">
        <rect width="512" height="512" fill="white"/>
        <line x1="86" y1="274" x2="254" y2="62" stroke="black" stroke-width="32"/>
        <circle cx="298" cy="332" r="42" fill="black"/>
        <line x1="298" y1="332" x2="384" y2="272" stroke="black" stroke-width="34" stroke-linecap="round"/>
        <line x1="298" y1="332" x2="372" y2="386" stroke="black" stroke-width="34" stroke-linecap="round"/>
        <line x1="298" y1="332" x2="246" y2="442" stroke="black" stroke-width="34" stroke-linecap="round"/>
      </mask>
    </defs>
    <path d="M 158 126 H 264 C 316 126 346 156 346 202 C 346 238 328 262 298 270 L 332 332 L 266 332 L 234 274 H 206 V 380 L 148 354 V 136 Q 148 126 158 126 Z M 206 174 H 258 C 278 174 290 185 290 202 C 290 219 278 230 258 230 H 206 Z" fill="#1FE07B" fill-rule="evenodd" mask="url(#r-cut-unread)"/>
    <path d="M 94 264 L 165 166 L 244 74 L 173 172 Z" fill="#1FE07B"/>
    <line x1="298" y1="332" x2="384" y2="272" stroke="#1FE07B" stroke-width="18" stroke-linecap="round"/>
    <line x1="384" y1="272" x2="372" y2="386" stroke="#1FE07B" stroke-width="18" stroke-linecap="round"/>
    <line x1="298" y1="332" x2="372" y2="386" stroke="#1FE07B" stroke-width="18" stroke-linecap="round"/>
    <line x1="298" y1="332" x2="246" y2="442" stroke="#1FE07B" stroke-width="18" stroke-linecap="round"/>
    <line x1="372" y1="386" x2="246" y2="442" stroke="#1FE07B" stroke-width="18" stroke-linecap="round"/>
    <circle cx="384" cy="272" r="28" fill="#1FE07B"/>
    <circle cx="298" cy="332" r="28" fill="#1FE07B"/>
    <circle cx="372" cy="386" r="28" fill="#1FE07B"/>
    <circle cx="246" cy="442" r="28" fill="#1FE07B"/>
    <circle cx="422" cy="90" r="74" fill="#ff3b30" stroke="#141617" stroke-width="22"/>
  </svg>`
);

export class NotificationManager {
  private roomId: string;
  private soundMuted: boolean;
  private unreadCount = 0;
  private audioCtx: AudioContext | null = null;
  private onActiveHandler: (() => void) | null = null;
  private lastTitle = '';
  private lastBadgeState: boolean | null = null;

  constructor(roomId: string, soundMuted: boolean) {
    this.roomId = roomId;
    this.soundMuted = soundMuted;
    this.bindVisibilityListeners();
    this.syncDocumentChrome();
  }

  private bindVisibilityListeners(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    this.onActiveHandler = () => {
      if (!document.hidden && document.hasFocus()) {
        this.markRead();
      }
    };
    document.addEventListener('visibilitychange', this.onActiveHandler);
    window.addEventListener('focus', this.onActiveHandler);
  }

  public destroy(): void {
    if (this.onActiveHandler && typeof window !== 'undefined' && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onActiveHandler);
      window.removeEventListener('focus', this.onActiveHandler);
    }
    this.onActiveHandler = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  public updateContext(roomId: string, soundMuted: boolean): void {
    this.roomId = roomId;
    this.soundMuted = soundMuted;
    this.syncDocumentChrome();
  }

  public isHidden(): boolean {
    if (typeof document === 'undefined') return false;
    return document.hidden || !document.hasFocus();
  }

  public unlockAudio(): void {
    try {
      if (typeof AudioContext === 'undefined') return;
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext();
      }
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume();
      }
    } catch {
      // ignore audio restrictions
    }
  }

  public playChime(): void {
    if (this.soundMuted) return;
    try {
      if (typeof AudioContext === 'undefined') return;
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext();
      }
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(784, now);
      osc1.frequency.exponentialRampToValueAtTime(1046.5, now + 0.08);
      gain1.gain.setValueAtTime(0.001, now);
      gain1.gain.linearRampToValueAtTime(0.06, now + 0.015);
      gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.17);
    } catch {
      // ignore blocked audio
    }
  }

  public onIncomingMessage(): void {
    this.playChime();
    if (this.isHidden()) {
      this.unreadCount += 1;
      this.syncDocumentChrome();
    }
  }

  public markRead(): void {
    if (this.unreadCount === 0) return;
    this.unreadCount = 0;
    this.syncDocumentChrome();
  }

  private syncDocumentChrome(): void {
    if (typeof document === 'undefined') return;
    const hasUnread = this.unreadCount > 0;
    const nextTitle = hasUnread
      ? `(${this.unreadCount}) #${this.roomId} — revchat`
      : `#${this.roomId} — revchat`;
    if (nextTitle !== this.lastTitle) {
      document.title = nextTitle;
      this.lastTitle = nextTitle;
    }

    if (hasUnread !== this.lastBadgeState) {
      const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
      if (link) {
        link.href = hasUnread ? `data:image/svg+xml,${BADGE_FAVICON_SVG}` : './favicon.svg';
        this.lastBadgeState = hasUnread;
      }
    }
  }
}
