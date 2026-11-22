import { DEFAULT_FONT_SIZE, clampFontSize } from './commands';
import { UserProfile } from './types';

const LEGACY_SESSION_PROFILE_KEY = 'revchat_session_profile_v2';
const SESSION_PROFILE_KEY = 'revchat_session_profile_v3';

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

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

export function generateRoomKey(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
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

export function sanitizeRoomKey(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null;
  const cleaned = input.trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (cleaned.length < 16 || cleaned.length > 128) return null;
  return cleaned;
}

/**
 * Parses roomId and optional E2EE roomKey from URL.
 * Prefers URL Hash Fragment (#room=...&k=...) which browsers never send in HTTP requests.
 * Falls back to legacy ?room=... query string for compatibility.
 */
export function parseRoomFromUrl(href: string): { roomId: string; roomKey: string | null } {
  try {
    const url = new URL(href);
    const hashRaw = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    if (hashRaw) {
      if (hashRaw.includes('=')) {
        const hashParams = new URLSearchParams(hashRaw);
        const rawRoom = hashParams.get('room');
        const rawKey = sanitizeRoomKey(hashParams.get('k'));
        if (rawRoom) {
          return { roomId: normalizeRoomId(rawRoom), roomKey: rawKey };
        }
      } else {
        return { roomId: normalizeRoomId(decodeURIComponent(hashRaw)), roomKey: null };
      }
    }

    const fromQuery = url.searchParams.get('room');
    if (fromQuery) {
      return { roomId: normalizeRoomId(fromQuery), roomKey: null };
    }
  } catch {
    // ignore malformed URL
  }
  return { roomId: 'LOBBY', roomKey: null };
}

/**
 * Builds a clean shareable room URL storing room ID and E2EE key in the URL hash fragment.
 */
export function buildRoomUrl(baseHref: string, roomId: string, roomKey: string | null): string {
  const normalized = normalizeRoomId(roomId);
  try {
    const url = new URL(baseHref);
    url.searchParams.delete('room');
    url.searchParams.delete('peer');
    const hashParams = new URLSearchParams();
    hashParams.set('room', normalized);
    const cleanKey = sanitizeRoomKey(roomKey);
    if (cleanKey) {
      hashParams.set('k', cleanKey);
    }
    url.hash = `#${hashParams.toString()}`;
    return url.toString();
  } catch {
    const cleanKey = sanitizeRoomKey(roomKey);
    return `#room=${encodeURIComponent(normalized)}${cleanKey ? `&k=${encodeURIComponent(cleanKey)}` : ''}`;
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
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  } catch {
    // ignore storage errors
  }

  try {
    if (typeof sessionStorage !== 'undefined') {
      const savedV3 = sessionStorage.getItem(SESSION_PROFILE_KEY);
      const savedLegacy = savedV3 ? null : sessionStorage.getItem(LEGACY_SESSION_PROFILE_KEY);
      const saved = savedV3 ?? savedLegacy;
      if (savedLegacy) {
        sessionStorage.removeItem(LEGACY_SESSION_PROFILE_KEY);
      }
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<UserProfile>;
        if (parsed && typeof parsed.clientId === 'string' && parsed.clientId.length >= 4) {
          const reload = isPageReload();
          const savedClientId =
            parsed.clientId.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || randomId(6);
          const clientId = reload ? savedClientId : randomId(6);
          const rawNick =
            typeof parsed.nickname === 'string' ? parsed.nickname.trim().slice(0, 24) : '';
          const isLegacyAuto = /^(?:PEER|anon)-[A-Z0-9]+$/i.test(rawNick);
          const isAutoNick =
            !rawNick || isLegacyAuto || rawNick.toUpperCase() === savedClientId.toUpperCase();
          const defaultNick = clientId.toUpperCase();
          const nickname =
            isLegacyAuto || (!reload && isAutoNick) ? defaultNick : rawNick || defaultNick;
          const theme =
            parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'auto'
              ? parsed.theme
              : 'auto';
          const rawSize = parsed.fontSize as unknown;
          const fontSize =
            savedLegacy && (rawSize === 14 || rawSize === 's')
              ? DEFAULT_FONT_SIZE
              : typeof rawSize === 'number'
                ? clampFontSize(rawSize)
                : rawSize === 'l'
                  ? 20
                  : rawSize === 'm'
                    ? 16
                    : rawSize === 's'
                      ? 14
                      : DEFAULT_FONT_SIZE;
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
