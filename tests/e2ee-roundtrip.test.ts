import { describe, expect, it } from 'vitest';
import {
  decryptJson,
  derivePairwiseAesKey,
  encryptJson,
  generateSessionIdentity,
  signText,
  verifyText,
} from '../src/crypto';
import { validateChatMessage, validateIncomingPacket } from '../src/security';
import { ChatMessage } from '../src/types';

describe('E2EE chat wire roundtrip', () => {
  it('encrypts, signs, validates, and decrypts pairwise ECDH DM CHAT_MSG cleanly', async () => {
    const alice = await generateSessionIdentity();
    const bob = await generateSessionIdentity();

    const alicePairKey = await derivePairwiseAesKey(alice.ecdhKeyPair.privateKey, bob.ecdhPubB64);
    const bobPairKey = await derivePairwiseAesKey(bob.ecdhKeyPair.privateKey, alice.ecdhPubB64);
    expect(alicePairKey).not.toBeNull();
    expect(bobPairKey).not.toBeNull();

    const dmMsg: ChatMessage = {
      id: 'dm-e2ee-1',
      roomId: 'ROOM-PRIV1',
      senderId: 'revchat-p-alice',
      senderName: 'Alice',
      text: 'Private whisper!',
      timestamp: 1_700_000_005_000,
      targetPeerId: 'revchat-p-bob',
      targetPeerName: 'Bob',
      ackedBy: [],
      encrypted: true,
    };

    const sig = await signText(
      alice.signKeyPair.privateKey,
      `MSG:${dmMsg.id}:${dmMsg.senderId}:${dmMsg.timestamp}:${dmMsg.text}`
    );
    const cipher = await encryptJson(alicePairKey!, dmMsg);

    const pkt = validateIncomingPacket({
      packetId: 'pkt-dm-1',
      type: 'CHAT_MSG',
      roomId: 'ROOM-PRIV1',
      senderId: 'revchat-p-alice',
      senderName: 'Alice',
      timestamp: dmMsg.timestamp,
      ttl: 0,
      payload: { cipher, dmTarget: 'revchat-p-bob' },
      sig,
      enc: true,
    });
    expect(pkt).not.toBeNull();
    expect(pkt?.enc).toBe(true);

    const decrypted = await decryptJson<any>(bobPairKey!, pkt!.payload.cipher);
    expect(decrypted).not.toBeNull();

    const validatedMsg = validateChatMessage(decrypted?.message ?? decrypted, 'ROOM-PRIV1');
    expect(validatedMsg).not.toBeNull();
    expect(validatedMsg?.id).toBe(dmMsg.id);
    expect(validatedMsg?.text).toBe('Private whisper!');
    expect(validatedMsg?.targetPeerId).toBe('revchat-p-bob');

    const sigOk = await verifyText(
      alice.signPubB64,
      `MSG:${validatedMsg!.id}:${validatedMsg!.senderId}:${validatedMsg!.timestamp}:${validatedMsg!.text}`,
      pkt!.sig!
    );
    expect(sigOk).toBe(true);
  });

  it('rejects DM ciphertext when decrypted by a third peer with a different pairwise key', async () => {
    const alice = await generateSessionIdentity();
    const bob = await generateSessionIdentity();
    const charlie = await generateSessionIdentity();

    const aliceToBobKey = await derivePairwiseAesKey(alice.ecdhKeyPair.privateKey, bob.ecdhPubB64);
    const charlieFromAliceKey = await derivePairwiseAesKey(
      charlie.ecdhKeyPair.privateKey,
      alice.ecdhPubB64
    );

    const cipher = await encryptJson(aliceToBobKey!, {
      id: 'm1',
      senderId: 'revchat-p-alice',
      senderName: 'Alice',
      text: 'secret for bob only',
      timestamp: 1_700_000_000_000,
    });
    expect(await decryptJson(charlieFromAliceKey!, cipher)).toBeNull();
  });
});
