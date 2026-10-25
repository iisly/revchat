import { UserProfile } from './types';

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
  return `ROOM-${randomId(6).toUpperCase()}`;
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

export function createSessionProfile(): UserProfile {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // ignore storage errors
  }

  const clientId = randomId(6);
  return {
    clientId,
    nickname: `PEER-${clientId.toUpperCase()}`,
    theme: 'auto',
  };
}
