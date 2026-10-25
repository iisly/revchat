import { ChatMessage, P2PPacket, PacketType } from './types';

export const MAX_MESSAGE_TEXT_LENGTH = 4_000;
export const MAX_NICKNAME_LENGTH = 24;
export const MAX_ID_LENGTH = 64;
export const MAX_PEERS_IN_ROOM = 32;
export const RATE_LIMIT_WINDOW_MS = 5_000;
export const RATE_LIMIT_MAX_PACKETS = 30;

const ALLOWED_PACKET_TYPES = new Set<PacketType>([
  'HELLO',
  'PEER_LIST',
  'CHAT_MSG',
  'CHAT_ACK',
  'TYPING',
  'PING',
  'PONG',
  'NICK_CHANGE',
  'LEAVE',
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizeObject(input: unknown, depth = 0): any {
  if (depth > 5 || input === null || input === undefined) return undefined;
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 60).map((item) => sanitizeObject(item, depth + 1));
  }
  if (typeof input === 'object') {
    const out: Record<string, any> = Object.create(null);
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      out[k] = sanitizeObject(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function sanitizeString(val: unknown, maxLen: number, fallback = ''): string {
  if (typeof val !== 'string') return fallback;
  return val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, maxLen);
}

export function sanitizeId(val: unknown): string {
  if (typeof val !== 'string') return '';
  return val.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, MAX_ID_LENGTH);
}

export function validateIncomingPacket(raw: unknown): P2PPacket | null {
  if (!raw || typeof raw !== 'object') return null;
  const clean = sanitizeObject(raw);
  if (!clean) return null;

  const packetId = sanitizeId(clean.packetId);
  const type = clean.type as PacketType;
  const roomId = sanitizeId(clean.roomId).toUpperCase();
  const senderId = sanitizeId(clean.senderId);
  const senderName = sanitizeString(clean.senderName, MAX_NICKNAME_LENGTH, 'peer').trim() || 'peer';
  const timestamp = Number(clean.timestamp);
  const ttl = Math.min(3, Math.max(0, Math.floor(Number(clean.ttl) || 0)));

  if (!packetId || !senderId || !roomId || !ALLOWED_PACKET_TYPES.has(type)) {
    return null;
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  return {
    packetId,
    type,
    roomId,
    senderId,
    senderName,
    timestamp,
    ttl,
    payload: clean.payload ?? {},
  };
}

export function validateChatMessage(raw: unknown, fallbackRoomId: string): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = sanitizeId(m.id);
  const senderId = sanitizeId(m.senderId);
  const senderName = sanitizeString(m.senderName, MAX_NICKNAME_LENGTH, 'peer').trim() || 'peer';
  const text = sanitizeString(m.text, MAX_MESSAGE_TEXT_LENGTH).trim();
  const timestamp = Number(m.timestamp);
  const roomId = sanitizeId(m.roomId).toUpperCase() || fallbackRoomId;

  if (!id || !senderId || !text || !Number.isFinite(timestamp)) {
    return null;
  }

  let replyTo: ChatMessage['replyTo'] | undefined;
  if (m.replyTo && typeof m.replyTo === 'object') {
    const r = m.replyTo as Record<string, unknown>;
    const rId = sanitizeId(r.id);
    const rSender = sanitizeString(r.senderName, MAX_NICKNAME_LENGTH);
    const rText = sanitizeString(r.text, 120);
    if (rId && rSender && rText) {
      replyTo = { id: rId, senderName: rSender, text: rText };
    }
  }

  const targetPeerId = m.targetPeerId ? sanitizeId(m.targetPeerId) : undefined;
  const targetPeerName = m.targetPeerName
    ? sanitizeString(m.targetPeerName, MAX_NICKNAME_LENGTH)
    : undefined;

  return {
    id,
    roomId,
    senderId,
    senderName,
    text,
    timestamp,
    replyTo,
    targetPeerId: targetPeerId || undefined,
    targetPeerName: targetPeerName || undefined,
    ackedBy: [],
  };
}

export class PeerRateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  public allow(peerId: string): boolean {
    const now = Date.now();
    const entry = this.buckets.get(peerId);
    if (!entry || now > entry.resetAt) {
      this.buckets.set(peerId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    entry.count += 1;
    return entry.count <= RATE_LIMIT_MAX_PACKETS;
  }

  public prune(): void {
    const now = Date.now();
    for (const [peerId, entry] of this.buckets.entries()) {
      if (now > entry.resetAt) {
        this.buckets.delete(peerId);
      }
    }
  }
}
