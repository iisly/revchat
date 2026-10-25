import { UserProfile } from './types';

const PROFILE_KEY = 'revchat_profile_v1';

function randomId(len = 6): string {
  const chars = '23456789abcdefghjkmnpqrstuvwxyz';
  let out = '';
  const array = new Uint8Array(len);
  crypto.getRandomValues(array);
  for (let i = 0; i < len; i++) {
    out += chars[array[i] % chars.length];
  }
  return out;
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${randomId(8)}`;
}

export function generateRoomCode(): string {
  const p1 = randomId(4).toUpperCase();
  return `ROOM-${p1}`;
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

export function loadUserProfile(): UserProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserProfile>;
      if (parsed.clientId && parsed.nickname) {
        return {
          clientId: parsed.clientId,
          nickname: parsed.nickname.slice(0, 24),
          theme: parsed.theme || 'auto',
          soundEnabled: parsed.soundEnabled ?? false,
          syncHistoryOnJoin: parsed.syncHistoryOnJoin ?? true,
        };
      }
    }
  } catch {
    // ignore storage errors
  }

  const clientId = randomId(6);
  const defaultProfile: UserProfile = {
    clientId,
    nickname: `peer-${clientId.slice(0, 4)}`,
    theme: 'auto',
    soundEnabled: false,
    syncHistoryOnJoin: true,
  };
  saveUserProfile(defaultProfile);
  return defaultProfile;
}

export function saveUserProfile(profile: UserProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // ignore
  }
}
