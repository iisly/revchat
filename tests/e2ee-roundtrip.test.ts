import { describe, expect, it } from 'vitest';
import {
  decryptJson,
  derivePairwiseAesKey,
  encryptJson,
  generateSessionIdentity,
  importRoomKey,
  signText,
  verifyText,
} from '../src/crypto';
import { validateChatMessage, validateIncomingPacket } from '../src/security';
import { generateRoomKey } from '../src/storage';
import { ChatMessage } from '../src/types';

describe('E2EE chat wire roundtrip', () => {
  it('encrypts, validates packet, decrypts, and validates room E2EE CHAT_MSG cleanly', async () => {
    const roomKeyStr = generateRoomKey();
    const roomKeyA = await importRoomKey(roomKeyStr);
    const roomKeyB = await importRoomKey(roomKeyStr);
    const senderIdData = await generateSessionIdentity();

    const msg: ChatMessage = {
      id: 'msg-e2ee-1',
      roomId: 'ROOM-PRIV1',
      senderId: 'revchat-p-alice',
      senderName: 'Alice',
      text: 'Top secret hello!',
      timestamp: 1_700_000_000_000,
      ackedBy: [],
      encrypted: true,
    };

    const sig = await signText(
      senderIdData.signKeyPair.privateKey,
      `MSG:${msg.id}:${msg.senderId}:${msg.timestamp}:${msg.text}`
    );
    const cipher = await encryptJson(roomKeyA!, msg);

    const validatedPacket = validateIncomingPacket({
      packetId: 'pkt-100',
      type: 'CHAT_MSG',
      roomId: 'ROOM-PRIV1',
      senderId: 'revchat-p-alice',
      senderName: 'Alice',
      timestamp: msg.timestamp,
      ttl: 1,
      payload: { cipher },
      sig,
      enc: true,
    });
    expect(validatedPacket).not.toBeNull();
    expect(validatedPacket?.enc).toBe(true);

    const decrypted = await decryptJson<any>(roomKeyB!, validatedPacket!.payload.cipher);
    expect(decrypted).not.toBeNull();

    const msgObj = decrypted?.message ?? decrypted;
    const validatedMsg = validateChatMessage(msgObj, 'ROOM-PRIV1');
    expect(validatedMsg).not.toBeNull();
    expect(validatedMsg?.id).toBe(msg.id);
    expect(validatedMsg?.text).toBe('Top secret hello!');

    const sigOk = await verifyText(
      senderIdData.signPubB64,
      `MSG:${validatedMsg!.id}:${validatedMsg!.senderId}:${validatedMsg!.timestamp}:${validatedMsg!.text}`,
      validatedPacket!.sig!
    );
    expect(sigOk).toBe(true);
  });

  it('handles pairwise ECDH DM encryption & validation accurately', async () => {
    const alice = await generateSessionIdentity();
    const bob = await generateSessionIdentity();

    const alicePairKey = await derivePairwiseAesKey(alice.ecdhKeyPair.privateKey, bob.ecdhPubB64);
    const bobPairKey = await derivePairwiseAesKey(bob.ecdhKeyPair.privateKey, alice.ecdhPubB64);

    const dmMsg: ChatMessage = {
      id: 'dm-1',
      roomId: 'LOBBY',
      senderId: 'revchat-p-alice',
      senderName: 'Alice',
      text: 'Private whisper',
      timestamp: 1_700_000_005_000,
      targetPeerId: 'revchat-p-bob',
      targetPeerName: 'Bob',
      ackedBy: [],
    };

    const cipher = await encryptJson(alicePairKey!, dmMsg);
    const pkt = validateIncomingPacket({
      packetId: 'pkt-dm-1',
      type: 'CHAT_MSG',
      roomId: 'LOBBY',
      senderId: 'revchat-p-alice',
      senderName: 'Alice',
      timestamp: dmMsg.timestamp,
      ttl: 0,
      payload: { cipher, dmTarget: 'revchat-p-bob' },
      enc: true,
    });

    const decrypted = await decryptJson<any>(bobPairKey!, pkt!.payload.cipher);
    const validatedMsg = validateChatMessage(decrypted?.message ?? decrypted, 'LOBBY');
    expect(validatedMsg?.text).toBe('Private whisper');
    expect(validatedMsg?.targetPeerId).toBe('revchat-p-bob');
  });

  it('rejects ciphertext when decrypted with a different room key', async () => {
    const key1 = await importRoomKey(generateRoomKey());
    const wrongKey = await importRoomKey(generateRoomKey());
    const cipher = await encryptJson(key1!, {
      id: 'm1',
      senderId: 'p1',
      senderName: 'A',
      text: 'secret',
      timestamp: 1_700_000_000_000,
    });
    expect(await decryptJson(wrongKey!, cipher)).toBeNull();
  });
});
