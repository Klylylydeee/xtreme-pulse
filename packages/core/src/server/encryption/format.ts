import { mongo } from 'mongoose';
import { AEAD_MIN_BYTES } from './aead';

// The stored format of an encrypted field value (see fields.ts): BSON binary subtype 6, header
// (algorithm, key id, plaintext type) then IV, ciphertext and tag. Kept apart from fields.ts so the
// write guard can check values without importing the key vault.

export const RANDOM_ALGORITHM = 2;
export const HEADER_BYTES = 18;
export const BSON_STRING = 0x02;
export const BSON_INT32 = 0x10;
export const BSON_INT64 = 0x12;
export const ENCRYPTED_SUBTYPE = mongo.Binary.SUBTYPE_ENCRYPTED; // 6

/** The raw bytes of a stored value: a driver Binary, a Mongoose buffer, or plain bytes. */
export function bytesOf(value: unknown): Buffer | null {
  if (value instanceof mongo.Binary) {
    if (value.sub_type !== ENCRYPTED_SUBTYPE) return null;
    const content = value.value();
    return Buffer.from(content.buffer, content.byteOffset, content.length);
  }
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.length);
  return null;
}

/**
 * True when `value` looks like a value this module encrypted: the right header and length. It
 * doesn't prove the value decrypts (that needs the key).
 */
export function isEncryptedValue(value: unknown): boolean {
  const bytes = bytesOf(value);
  if (!bytes || bytes.length < HEADER_BYTES + AEAD_MIN_BYTES) return false;
  if (bytes[0] !== RANDOM_ALGORITHM) return false;
  if (![BSON_STRING, BSON_INT32, BSON_INT64].includes(bytes[17] ?? -1)) return false;
  return (bytes.length - HEADER_BYTES - AEAD_MIN_BYTES) % 16 === 0;
}
