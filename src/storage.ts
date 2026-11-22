import { DEFAULT_FONT_SIZE, clampFontSize } from './commands';
import { UserProfile } from './types';

const SESSION_PROFILE_KEY = 'revchat_session_profile';

function randomId(len = 6): string {
  const chars = '23456789abcdefghjkmnpqrstuvwxyz';
  let out = '';
  const array = new Uint8Array(len);
  globalThis.crypto.getRandomValues(array);
  for (let i = 0; i < len; i++) {
    out += chars[array[i] % chars.length];
  }
  return out;
}

export function generateUUID(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${randomId(8)}`;
}

export function generateRoomCode(): string {
  return randomId(6).toUpperCase();
}

export function normalizeRoomId(input: string): string {
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, 32) || 'LOBBY';
}

/**
 * Parses roomId from URL hash fragment (#room=... or #ROOM), defaulting to LOBBY.
 */
export function parseRoomFromUrl(href: string): string {
  try {
    const url = new URL(href);
    const hashRaw = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    if (hashRaw) {
      if (hashRaw.includes('=')) {
        const rawRoom = new URLSearchParams(hashRaw).get('room');
        if (rawRoom) {
          return normalizeRoomId(rawRoom);
        }
      } else {
        return normalizeRoomId(decodeURIComponent(hashRaw));
      }
    }
  } catch {
    // ignore malformed URL
  }
  return 'LOBBY';
}

/**
 * Builds a clean shareable room URL storing room ID in the URL hash fragment.
 */
export function buildRoomUrl(baseHref: string, roomId: string): string {
  const normalized = normalizeRoomId(roomId);
  try {
    const url = new URL(baseHref);
    url.hash = `#room=${encodeURIComponent(normalized)}`;
    return url.toString();
  } catch {
    return `#room=${encodeURIComponent(normalized)}`;
  }
}

function isPageReload(): boolean {
  try {
    const nav = globalThis.performance?.getEntriesByType?.('navigation')?.[0] as
      | PerformanceNavigationTiming
      | undefined;
    return nav?.type === 'reload';
  } catch {
    return false;
  }
}

/**
 * Creates or restores a tab-scoped session profile.
 * Never touches persistent localStorage; sessionStorage auto-wipes when the browser tab closes.
 * Reuses clientId only on actual page reloads so duplicate/cloned tabs never collide on Peer ID.
 */
export function createSessionProfile(): UserProfile {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const saved = sessionStorage.getItem(SESSION_PROFILE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<UserProfile>;
        if (parsed && typeof parsed.clientId === 'string' && parsed.clientId.length >= 4) {
          const reload = isPageReload();
          const savedClientId =
            parsed.clientId.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || randomId(6);
          const clientId = reload ? savedClientId : randomId(6);
          const rawNick =
            typeof parsed.nickname === 'string' ? parsed.nickname.trim().slice(0, 24) : '';
          const isAutoNick = !rawNick || rawNick.toUpperCase() === savedClientId.toUpperCase();
          const defaultNick = clientId.toUpperCase();
          const nickname = !reload && isAutoNick ? defaultNick : rawNick || defaultNick;
          const theme =
            parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'auto'
              ? parsed.theme
              : 'auto';
          const fontSize =
            typeof parsed.fontSize === 'number' ? clampFontSize(parsed.fontSize) : DEFAULT_FONT_SIZE;
          const soundMuted = Boolean(parsed.soundMuted);
          const resolved: UserProfile = { clientId, nickname, theme, fontSize, soundMuted };
          saveSessionProfile(resolved);
          return resolved;
        }
      }
    }
  } catch {
    // fall through to new profile
  }

  const clientId = randomId(6);
  const fresh: UserProfile = {
    clientId,
    nickname: clientId.toUpperCase(),
    theme: 'auto',
    fontSize: DEFAULT_FONT_SIZE,
    soundMuted: false,
  };
  saveSessionProfile(fresh);
  return fresh;
}

export function saveSessionProfile(profile: UserProfile): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(SESSION_PROFILE_KEY, JSON.stringify(profile));
    }
  } catch {
    // ignore quota/private-mode errors
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to execCommand for non-HTTPS LAN contexts
  }
  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
