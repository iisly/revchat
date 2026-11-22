import { describe, expect, it } from 'vitest';
import {
  MAX_MEDIA_BYTES,
  PeerRateLimiter,
  isAllowedReaction,
  sanitizeFilename,
  sanitizeObject,
  validateChatMessage,
  validateIncomingPacket,
  validateMediaMeta,
} from '../src/security';

describe('security module', () => {
  it('strips prototype-polluting keys cleanly', () => {
    const malicious = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"safe":"ok"}');
    const clean = sanitizeObject(malicious);
    expect(Object.getPrototypeOf(clean)).toBeNull();
    expect(clean.safe).toBe('ok');
    expect(({} as any).polluted).toBeUndefined();
    expect('__proto__' in clean).toBe(false);
    expect('constructor' in clean).toBe(false);
  });

  it('validates incoming packets including v2 packet types and preserves sig/enc', () => {
    const valid = validateIncomingPacket({
      packetId: 'pkt-1',
      type: 'REACTION',
      roomId: 'lobby',
      senderId: 'revchat-p-abc',
      senderName: 'Alice',
      timestamp: Date.now(),
      payload: { messageId: 'm1', emoji: '👍' },
      sig: 'abc123',
      enc: true,
    });
    expect(valid).not.toBeNull();
    expect(valid?.roomId).toBe('LOBBY');
    expect(valid?.sig).toBe('abc123');
    expect(valid?.enc).toBe(true);

    expect(
      validateIncomingPacket({
        packetId: 'pkt-2',
        type: 'UNKNOWN_TYPE',
        roomId: 'LOBBY',
        senderId: 'peer1',
        timestamp: Date.now(),
      })
    ).toBeNull();
  });

  it('sanitizes filenames against traversal and control chars', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_._etc_passwd');
    expect(sanitizeFilename('...hidden.png')).toBe('hidden.png');
    expect(sanitizeFilename('   ')).toBe('file');
  });

  it('validates media metadata within size bounds', () => {
    expect(
      validateMediaMeta({
        transferId: 't-1',
        kind: 'image',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: 1024,
      })
    ).toMatchObject({ kind: 'image', name: 'photo.jpg', size: 1024, status: 'receiving' });

    expect(
      validateMediaMeta({
        transferId: 't-2',
        kind: 'file',
        name: 'huge.zip',
        size: MAX_MEDIA_BYTES + 1,
      })
    ).toBeNull();

    expect(
      validateMediaMeta({
        transferId: 't-3',
        kind: 'executable',
        name: 'bad.exe',
        size: 500,
      })
    ).toBeNull();
  });

  it('accepts attachment-only chat messages without text', () => {
    const msg = validateChatMessage(
      {
        id: 'm-1',
        senderId: 'peer-1',
        senderName: 'Bob',
        text: '',
        timestamp: Date.now(),
        attachment: {
          transferId: 'm-1',
          kind: 'audio',
          name: 'voice.m4a',
          mimeType: 'audio/mp4',
          size: 4096,
        },
      },
      'LOBBY'
    );
    expect(msg).not.toBeNull();
    expect(msg?.attachment?.kind).toBe('audio');
  });

  it('enforces reaction whitelist and peer rate limiter', () => {
    expect(isAllowedReaction('👍')).toBe(true);
    expect(isAllowedReaction('<script>')).toBe(false);

    const rl = new PeerRateLimiter();
    for (let i = 0; i < 60; i++) {
      expect(rl.allow('peer-a')).toBe(true);
    }
    expect(rl.allow('peer-a')).toBe(false);
  });
});
