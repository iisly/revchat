import { ChatMessage, MediaAttachment, MediaKind, P2PPacket, PacketType } from './types';

export const MAX_MESSAGE_TEXT_LENGTH = 4_000;
export const MAX_NICKNAME_LENGTH = 24;
export const MAX_ID_LENGTH = 64;
export const MAX_PEERS_IN_ROOM = 32;
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const RATE_LIMIT_WINDOW_MS = 5_000;
export const RATE_LIMIT_MAX_PACKETS = 60;

export const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;
const REACTION_SET = new Set<string>(ALLOWED_REACTIONS);

const ALLOWED_PACKET_TYPES = new Set<PacketType>([
  'HELLO',
  'CHAT_MSG',
  'CHAT_ACK',
  'TYPING',
  'PING',
  'PONG',
  'NICK_CHANGE',
  'LEAVE',
  'REACTION',
  'DELETE_MSG',
  'MEDIA_CANCEL',
  'CALL_STATE',
]);

const ALLOWED_MEDIA_KINDS = new Set<MediaKind>(['image', 'video', 'audio', 'file']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isAllowedReaction(emoji: string): boolean {
  return REACTION_SET.has(emoji);
}

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
    const entries = Object.entries(input as Record<string, unknown>).slice(0, 32);
    for (const [k, v] of entries) {
      if (FORBIDDEN_KEYS.has(k) || k.length > 64) continue;
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

export function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== 'string') return 'file';
  const base = raw
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[/\\]+/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return base || 'file';
}

export function validateMediaMeta(raw: unknown): MediaAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const transferId = sanitizeId(m.transferId);
  const kind = m.kind as MediaKind;
  const name = sanitizeFilename(m.name);
  const mimeType =
    sanitizeString(m.mimeType, 80, 'application/octet-stream')
      .replace(/[^a-zA-Z0-9/+.;=\- ]/g, '')
      .trim() || 'application/octet-stream';
  const size = Number(m.size);
  const durationSecRaw = m.durationSec !== undefined ? Number(m.durationSec) : undefined;
  const durationSec =
    durationSecRaw !== undefined && Number.isFinite(durationSecRaw) && durationSecRaw >= 0
      ? Math.min(600, Math.round(durationSecRaw))
      : undefined;

  if (!transferId || !ALLOWED_MEDIA_KINDS.has(kind)) return null;
  if (!Number.isFinite(size) || size <= 0 || size > MAX_MEDIA_BYTES) return null;

  return {
    transferId,
    kind,
    name,
    mimeType,
    size: Math.floor(size),
    durationSec,
    progress: 0,
    status: 'receiving',
  };
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

  const sig = typeof clean.sig === 'string' ? clean.sig.slice(0, 256) : undefined;
  const enc = typeof clean.enc === 'boolean' ? clean.enc : undefined;

  return {
    packetId,
    type,
    roomId,
    senderId,
    senderName,
    timestamp,
    ttl,
    payload: clean.payload ?? {},
    ...(sig ? { sig } : {}),
    ...(enc !== undefined ? { enc } : {}),
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
  const attachment = m.attachment ? validateMediaMeta(m.attachment) || undefined : undefined;

  if (!id || !senderId || !Number.isFinite(timestamp) || (!text && !attachment)) {
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
    attachment,
    ackedBy: [],
  };
}

export class PeerRateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  public allow(peerId: string): boolean {
    if (!peerId || peerId.length > MAX_ID_LENGTH) return false;
    const now = Date.now();
    const entry = this.buckets.get(peerId);
    if (!entry || now > entry.resetAt) {
      if (!entry && this.buckets.size >= 256) {
        this.prune();
        if (this.buckets.size >= 256) return false;
      }
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
