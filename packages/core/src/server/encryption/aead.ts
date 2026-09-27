import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// AEAD_AES_256_CBC_HMAC_SHA_512, the authenticated encryption that MongoDB Client-Side Field Level
// Encryption uses for both its data keys and its field values (the MongoDB FLE specification,
// after draft-mcgrew-aead-aes-cbc-hmac-sha2). Encrypt-then-MAC:
//
//   key (96 bytes) = MAC key (32) || encryption key (32) || IV key (32, deterministic mode only)
//   S = AES-256-CBC(encryption key, IV, PKCS#7 padded plaintext), IV random (16 bytes)
//   T = first 32 bytes of HMAC-SHA-512(MAC key, AD || IV || S || AL), AL = bit length of AD as a
//       64-bit big-endian number
//   output = IV || S || T
//
// Only the random mode is implemented: no sensitive field needs equality search today.

export const AEAD_KEY_BYTES = 96;
const PART = 32;
const IV_BYTES = 16;
const BLOCK_BYTES = 16;
const TAG_BYTES = 32;
/** The shortest valid output: IV, one block of ciphertext and the tag. */
export const AEAD_MIN_BYTES = IV_BYTES + BLOCK_BYTES + TAG_BYTES;

/**
 * Thrown when a ciphertext fails its integrity check or can't be decrypted: it was altered, or it
 * was encrypted with another key. Deliberately says nothing more and carries no `cause`.
 */
export class DecryptionFailedError extends Error {
  constructor(
    message = 'An encrypted value could not be decrypted: it was changed, or it was encrypted with a different key.',
  ) {
    super(message);
    this.name = 'DecryptionFailedError';
  }
}

function splitKey(key: Uint8Array): { macKey: Buffer; encKey: Buffer } {
  if (key.length !== AEAD_KEY_BYTES) throw new Error('Encryption key has the wrong length.');
  const buffer = Buffer.from(key.buffer, key.byteOffset, key.byteLength);
  return { macKey: buffer.subarray(0, PART), encKey: buffer.subarray(PART, PART * 2) };
}

function tag(macKey: Buffer, associatedData: Buffer, ivAndCiphertext: Buffer): Buffer {
  const bitLength = Buffer.alloc(8);
  bitLength.writeBigUInt64BE(BigInt(associatedData.length) * 8n);
  return createHmac('sha512', macKey)
    .update(associatedData)
    .update(ivAndCiphertext)
    .update(bitLength)
    .digest()
    .subarray(0, TAG_BYTES);
}

/** Encrypts `plaintext` with a random IV. Returns IV || ciphertext || tag. */
export function aeadEncrypt(key: Uint8Array, plaintext: Buffer, associatedData: Buffer): Buffer {
  const { macKey, encKey } = splitKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-cbc', encKey, iv);
  const ivAndCiphertext = Buffer.concat([iv, cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ivAndCiphertext, tag(macKey, associatedData, ivAndCiphertext)]);
}

/**
 * Checks the tag, then decrypts. Throws {@link DecryptionFailedError} when the data was altered or
 * the key is wrong; the tag is compared in constant time and nothing is decrypted before it passes.
 */
export function aeadDecrypt(key: Uint8Array, data: Buffer, associatedData: Buffer): Buffer {
  const { macKey, encKey } = splitKey(key);
  if (data.length < AEAD_MIN_BYTES || (data.length - IV_BYTES - TAG_BYTES) % BLOCK_BYTES !== 0) {
    throw new DecryptionFailedError();
  }
  const ivAndCiphertext = data.subarray(0, data.length - TAG_BYTES);
  const expected = tag(macKey, associatedData, ivAndCiphertext);
  if (!timingSafeEqual(expected, data.subarray(data.length - TAG_BYTES))) {
    throw new DecryptionFailedError();
  }
  try {
    const decipher = createDecipheriv('aes-256-cbc', encKey, ivAndCiphertext.subarray(0, IV_BYTES));
    return Buffer.concat([decipher.update(ivAndCiphertext.subarray(IV_BYTES)), decipher.final()]);
  } catch {
    // Only reachable with a valid tag and bad padding, i.e. data this code never wrote.
    throw new DecryptionFailedError();
  }
}
