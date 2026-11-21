import { ChatMessage } from './types';

export interface OutboxEntry {
  msg: ChatMessage;
  createdAt: number;
  pendingPeers: Set<string>;
  deliveredPeers: Set<string>;
}

/**
 * Tracks per-peer message delivery acknowledgments so multi-peer rooms do not drop
 * messages on the very first ACK, and reports true delivery failures upon TTL expiry.
 */
export class MessageOutbox {
  private entries = new Map<string, OutboxEntry>();

  public enqueue(msg: ChatMessage, connectedPeerIds: string[], now = Date.now()): void {
    const targets = msg.targetPeerId
      ? connectedPeerIds.filter((id) => id === msg.targetPeerId)
      : connectedPeerIds;
    this.entries.set(msg.id, {
      msg,
      createdAt: now,
      pendingPeers: new Set(targets),
      deliveredPeers: new Set(),
    });
  }

  public acknowledge(
    messageId: string,
    ackPeerId: string
  ): 'partial' | 'complete' | 'unknown' {
    const entry = this.entries.get(messageId);
    if (!entry) return 'unknown';

    if (entry.msg.targetPeerId && entry.msg.targetPeerId !== ackPeerId) {
      return 'unknown';
    }

    entry.deliveredPeers.add(ackPeerId);
    entry.pendingPeers.delete(ackPeerId);

    if (entry.pendingPeers.size === 0) {
      this.entries.delete(messageId);
      return 'complete';
    }
    return 'partial';
  }

  public getMessagesForPeer(
    peerId: string,
    roomId: string,
    now = Date.now(),
    ttlMs = 20_000
  ): ChatMessage[] {
    const result: ChatMessage[] = [];
    for (const entry of this.entries.values()) {
      if (entry.msg.roomId !== roomId) continue;
      if (now - entry.createdAt > ttlMs) continue;
      if (entry.deliveredPeers.has(peerId)) continue;
      if (entry.msg.targetPeerId && entry.msg.targetPeerId !== peerId) continue;
      result.push(entry.msg);
    }
    return result;
  }

  public getAllPendingMessages(
    roomId: string,
    now = Date.now(),
    ttlMs = 20_000
  ): ChatMessage[] {
    const result: ChatMessage[] = [];
    for (const entry of this.entries.values()) {
      if (entry.msg.roomId !== roomId) continue;
      if (now - entry.createdAt > ttlMs) continue;
      result.push(entry.msg);
    }
    return result;
  }

  /**
   * Evicts expired outbox entries and returns IDs of messages that were never
   * acknowledged by any peer.
   */
  public pruneExpired(now = Date.now(), ttlMs = 20_000): string[] {
    const failedIds: string[] = [];
    for (const [id, entry] of this.entries.entries()) {
      if (now - entry.createdAt > ttlMs) {
        if (entry.deliveredPeers.size === 0) {
          failedIds.push(id);
        }
        this.entries.delete(id);
      }
    }
    return failedIds;
  }

  public remove(messageId: string): void {
    this.entries.delete(messageId);
  }

  public clear(): void {
    this.entries.clear();
  }

  public has(messageId: string): boolean {
    return this.entries.has(messageId);
  }

  public size(): number {
    return this.entries.size;
  }
}
