const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    bin += String.fromCharCode(...sub);
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const bin = atob(normalized + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const cipher = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(data)
  );
  const cipherBytes = new Uint8Array(cipher);
  const out = new Uint8Array(12 + cipherBytes.byteLength);
  out.set(iv, 0);
  out.set(cipherBytes, 12);
  return out;
}

export async function decryptBytes(
  key: CryptoKey,
  combined: Uint8Array
): Promise<Uint8Array | null> {
  if (!combined || combined.byteLength < 13) return null;
  try {
    const iv = combined.subarray(0, 12);
    const cipherBytes = combined.subarray(12);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(cipherBytes)
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

export async function encryptJson(key: CryptoKey, obj: unknown): Promise<string> {
  const plain = textEncoder.encode(JSON.stringify(obj));
  const encrypted = await encryptBytes(key, plain);
  return bytesToBase64(encrypted);
}

export async function decryptJson<T>(key: CryptoKey, encoded: string): Promise<T | null> {
  try {
    const combined = base64ToBytes(encoded);
    const plain = await decryptBytes(key, combined);
    if (!plain) return null;
    return JSON.parse(textDecoder.decode(plain)) as T;
  } catch {
    return null;
  }
}

export interface SessionIdentity {
  signKeyPair: CryptoKeyPair;
  ecdhKeyPair: CryptoKeyPair;
  signPubB64: string;
  ecdhPubB64: string;
}

export async function generateSessionIdentity(): Promise<SessionIdentity> {
  const signKeyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify']
  );
  const ecdhKeyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey']
  );

  const signSpki = await globalThis.crypto.subtle.exportKey('spki', signKeyPair.publicKey);
  const ecdhSpki = await globalThis.crypto.subtle.exportKey('spki', ecdhKeyPair.publicKey);

  const signPubB64 = bytesToBase64(new Uint8Array(signSpki));
  const ecdhPubB64 = bytesToBase64(new Uint8Array(ecdhSpki));

  return { signKeyPair, ecdhKeyPair, signPubB64, ecdhPubB64 };
}

export async function signText(privateKey: CryptoKey, data: string): Promise<string> {
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    toArrayBuffer(textEncoder.encode(data))
  );
  return bytesToBase64(new Uint8Array(sig));
}

const MAX_VERIFY_KEY_CACHE = 64;
const verifyKeyCache = new Map<string, CryptoKey>();

export async function verifyText(
  pubB64: string,
  data: string,
  sigB64: string
): Promise<boolean> {
  try {
    let pubKey = verifyKeyCache.get(pubB64);
    if (!pubKey) {
      pubKey = await globalThis.crypto.subtle.importKey(
        'spki',
        toArrayBuffer(base64ToBytes(pubB64)),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
      if (verifyKeyCache.size >= MAX_VERIFY_KEY_CACHE) {
        const oldest = verifyKeyCache.keys().next().value;
        if (oldest !== undefined) verifyKeyCache.delete(oldest);
      }
      verifyKeyCache.set(pubB64, pubKey);
    }
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      toArrayBuffer(base64ToBytes(sigB64)),
      toArrayBuffer(textEncoder.encode(data))
    );
  } catch {
    return false;
  }
}

export async function derivePairwiseAesKey(
  myEcdhPrivate: CryptoKey,
  remoteEcdhPubB64: string
): Promise<CryptoKey | null> {
  try {
    const remotePub = await globalThis.crypto.subtle.importKey(
      'spki',
      toArrayBuffer(base64ToBytes(remoteEcdhPubB64)),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    return await globalThis.crypto.subtle.deriveKey(
      { name: 'ECDH', public: remotePub },
      myEcdhPrivate,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } catch {
    return null;
  }
}
