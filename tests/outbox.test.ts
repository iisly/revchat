import { describe, expect, it } from 'vitest';
import { MessageOutbox } from '../src/outbox';
import { ChatMessage } from '../src/types';

function makeMsg(id: string, targetPeerId?: string): ChatMessage {
  return {
    id,
    roomId: 'LOBBY',
    senderId: 'me',
    senderName: 'Me',
    text: 'hello',
    timestamp: 1000,
    targetPeerId,
    ackedBy: [],
  };
}

describe('MessageOutbox', () => {
  it('waits until all targeted peers acknowledge before removing entry', () => {
    const outbox = new MessageOutbox();
    const msg = makeMsg('m1');
    outbox.enqueue(msg, ['p1', 'p2'], 1000);

    expect(outbox.getMessagesForPeer('p1', 'LOBBY', 1500)).toHaveLength(1);
    expect(outbox.getMessagesForPeer('p2', 'LOBBY', 1500)).toHaveLength(1);

    // First ACK must only be partial — p2 still needs it
    expect(outbox.acknowledge('m1', 'p1')).toBe('partial');
    expect(outbox.has('m1')).toBe(true);
    expect(outbox.getMessagesForPeer('p1', 'LOBBY', 1500)).toHaveLength(0);
    expect(outbox.getMessagesForPeer('p2', 'LOBBY', 1500)).toHaveLength(1);

    // Second ACK completes delivery
    expect(outbox.acknowledge('m1', 'p2')).toBe('complete');
    expect(outbox.has('m1')).toBe(false);
  });

  it('isolates DMs strictly to targetPeerId', () => {
    const outbox = new MessageOutbox();
    const dm = makeMsg('dm1', 'p1');
    outbox.enqueue(dm, ['p1', 'p2'], 1000);

    expect(outbox.getMessagesForPeer('p1', 'LOBBY', 1100)).toHaveLength(1);
    expect(outbox.getMessagesForPeer('p2', 'LOBBY', 1100)).toHaveLength(0);

    // Unrelated peer cannot forge ACK for another peer's DM
    expect(outbox.acknowledge('dm1', 'p2')).toBe('unknown');
    expect(outbox.acknowledge('dm1', 'p1')).toBe('complete');
  });

  it('reports unacknowledged expired messages as failed while ignoring partially delivered ones', () => {
    const outbox = new MessageOutbox();
    outbox.enqueue(makeMsg('m-fail'), ['p1'], 1000);
    outbox.enqueue(makeMsg('m-partial'), ['p1', 'p2'], 1000);
    outbox.acknowledge('m-partial', 'p1');

    const failed = outbox.pruneExpired(25_000, 20_000);
    expect(failed).toEqual(['m-fail']);
    expect(outbox.size()).toBe(0);
  });
});
