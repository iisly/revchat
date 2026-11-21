import { describe, expect, it } from 'vitest';
import {
  computeFingerprint,
  decryptBytes,
  decryptJson,
  derivePairwiseAesKey,
  deriveRoomKeyFromPassphrase,
  encryptBytes,
  encryptJson,
  generateSessionIdentity,
  importRoomKey,
  signText,
  verifyText,
} from '../src/crypto';
import { generateRoomKey } from '../src/storage';

describe('crypto module', () => {
  it('encrypts and decrypts binary payloads with room key', async () => {
    const keyStr = generateRoomKey();
    const key = await importRoomKey(keyStr);
    expect(key).not.toBeNull();

    const raw = new TextEncoder().encode('hello p2p e2ee binary world');
    const cipher = await encryptBytes(key!, raw);
    expect(cipher.byteLength).toBeGreaterThan(raw.byteLength);

    const plain = await decryptBytes(key!, cipher);
    expect(plain).not.toBeNull();
    expect(new TextDecoder().decode(plain!)).toBe('hello p2p e2ee binary world');

    // Tamper 1 byte of ciphertext
    const tampered = new Uint8Array(cipher);
    tampered[tampered.byteLength - 1] ^= 0xff;
    expect(await decryptBytes(key!, tampered)).toBeNull();
  });

  it('rejects short or malformed room keys and short ciphertexts', async () => {
    expect(await importRoomKey('short')).toBeNull();
    const key = await importRoomKey(generateRoomKey());
    expect(await decryptBytes(key!, new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('encrypts and decrypts JSON objects and rejects wrong keys', async () => {
    const key1 = await importRoomKey(generateRoomKey());
    const key2 = await importRoomKey(generateRoomKey());
    const payload = { id: 'm1', text: 'secret', n: 42 };

    const encoded = await encryptJson(key1!, payload);
    expect(await decryptJson<typeof payload>(key1!, encoded)).toEqual(payload);
    expect(await decryptJson<typeof payload>(key2!, encoded)).toBeNull();
  });

  it('derives room-scoped AES keys from shared passphrase', async () => {
    const kA = await deriveRoomKeyFromPassphrase('freedom-pass', 'ROOM-A');
    const kA2 = await deriveRoomKeyFromPassphrase('freedom-pass', 'ROOM-A');
    const kB = await deriveRoomKeyFromPassphrase('freedom-pass', 'ROOM-B');

    const cipher = await encryptJson(kA, { msg: 'ok' });
    expect(await decryptJson(kA2, cipher)).toEqual({ msg: 'ok' });
    expect(await decryptJson(kB, cipher)).toBeNull();
  });

  it('signs and verifies messages with ECDSA P-256 and detects tampering', async () => {
    const id = await generateSessionIdentity();
    expect(id.fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(await computeFingerprint(id.signPubB64)).toBe(id.fingerprint);

    const sig = await signText(id.signKeyPair.privateKey, 'MSG:1:hello');
    expect(await verifyText(id.signPubB64, 'MSG:1:hello', sig)).toBe(true);
    expect(await verifyText(id.signPubB64, 'MSG:1:tampered', sig)).toBe(false);
  });

  it('derives identical pairwise ECDH AES-GCM keys between two peers', async () => {
    const alice = await generateSessionIdentity();
    const bob = await generateSessionIdentity();

    const aliceKey = await derivePairwiseAesKey(alice.ecdhKeyPair.privateKey, bob.ecdhPubB64);
    const bobKey = await derivePairwiseAesKey(bob.ecdhKeyPair.privateKey, alice.ecdhPubB64);
    expect(aliceKey).not.toBeNull();
    expect(bobKey).not.toBeNull();

    const whisper = await encryptJson(aliceKey!, { whisper: 'private' });
    expect(await decryptJson(bobKey!, whisper)).toEqual({ whisper: 'private' });
  });

  it('enforces ECDSA P-256 verification across all canonical packet types', async () => {
    const alice = await generateSessionIdentity();
    const attacker = await generateSessionIdentity();

    const payloads = [
      'MSG:m1:revchat-p-alice:1700000000000:hello',
      'REACT:m1:👍',
      'DEL:m1:revchat-p-alice',
      'NICK:revchat-p-alice:AliceNew',
      'MEDIA:t1:revchat-p-alice:voice.m4a:4096',
    ];

    for (const canonical of payloads) {
      const sig = await signText(alice.signKeyPair.privateKey, canonical);
      expect(await verifyText(alice.signPubB64, canonical, sig)).toBe(true);
      expect(await verifyText(attacker.signPubB64, canonical, sig)).toBe(false);
      expect(await verifyText(alice.signPubB64, `${canonical}:forged`, sig)).toBe(false);
    }
  });
});
