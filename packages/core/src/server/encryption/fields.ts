import { mongo, type SchemaTypeOptions } from 'mongoose';
import { aeadDecrypt, aeadEncrypt } from './aead';
import {
  BSON_INT32,
  BSON_INT64,
  BSON_STRING,
  bytesOf,
  ENCRYPTED_SUBTYPE,
  HEADER_BYTES,
  isEncryptedValue,
  RANDOM_ALGORITHM,
} from './format';
import { registerSensitiveFieldGuard, SENSITIVE_OPTION } from './guard';
import { withDataKey, withDefaultDataKey } from './key-vault';

// Explicit field encryption for sensitive data (SECURITY.md#sensitive-data,
// docs/adr/0005-field-level-encryption.md). A service encrypts each sensitive value before it
// saves it, and decrypts it only where the full value is needed (a reveal, a payroll calculation).
//
// Each value is stored as MongoDB's own encrypted-field format, BSON binary subtype 6 with the
// "random" algorithm (AEAD_AES_256_CBC_HMAC_SHA_512-Random):
//
//   byte 0       2 (random encryption)
//   bytes 1-16   the data key's UUID in the key vault
//   byte 17      the plaintext's BSON type (0x02 string, 0x12 64-bit integer)
//   bytes 18-    IV || AES-256-CBC ciphertext || HMAC tag, with bytes 0-17 as associated data
//
// so the same value encrypts differently every time, a changed byte (or a value moved to another
// key) is detected, and MongoDB's ClientEncryption can decrypt it too.

export { isEncryptedValue };

/** A sensitive value as stored: BSON binary subtype 6. Never decrypt it into a log or a cache. */
export type EncryptedValue = mongo.Binary;

/** What can be encrypted: text (IDs, account numbers) or a whole number (centavos). */
export type SensitivePlaintext = string | number;

/** Thrown for a value that isn't a string or a safe whole number. The message never includes it. */
export class SensitiveValueTypeError extends TypeError {
  constructor() {
    super('Only text or a whole number (such as an amount in centavos) can be encrypted.');
    this.name = 'SensitiveValueTypeError';
  }
}

/** Thrown when a stored value isn't an encrypted value this app can read. */
export class EncryptedValueFormatError extends Error {
  constructor() {
    super('The stored value is not an encrypted field value, so it can’t be decrypted.');
    this.name = 'EncryptedValueFormatError';
  }
}

function encodePlaintext(value: SensitivePlaintext): { type: number; bytes: Buffer } {
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    const bytes = Buffer.alloc(4 + text.length + 1);
    bytes.writeInt32LE(text.length + 1, 0);
    text.copy(bytes, 4);
    return { type: BSON_STRING, bytes };
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64LE(BigInt(value));
    return { type: BSON_INT64, bytes };
  }
  throw new SensitiveValueTypeError();
}

function decodePlaintext(type: number, bytes: Buffer): SensitivePlaintext {
  try {
    if (type === BSON_STRING) {
      const length = bytes.readInt32LE(0);
      if (length < 1 || bytes.length !== 4 + length || bytes[bytes.length - 1] !== 0) {
        throw new EncryptedValueFormatError();
      }
      return bytes.toString('utf8', 4, bytes.length - 1);
    }
    if (type === BSON_INT64 && bytes.length === 8) {
      const value = bytes.readBigInt64LE(0);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new EncryptedValueFormatError();
      }
      return Number(value);
    }
    if (type === BSON_INT32 && bytes.length === 4) return bytes.readInt32LE(0);
  } finally {
    bytes.fill(0);
  }
  throw new EncryptedValueFormatError();
}

/**
 * Encrypts a sensitive value for storage. Needs the database (for the key vault) and
 * FIELD_ENCRYPTION_LOCAL_KEY. Safe inside a transaction: the key vault is read outside it.
 */
export async function encryptSensitive(value: SensitivePlaintext): Promise<EncryptedValue> {
  const { type, bytes } = encodePlaintext(value);
  try {
    return await withDefaultDataKey((dataKey, keyId) => {
      const header = Buffer.alloc(HEADER_BYTES);
      header[0] = RANDOM_ALGORITHM;
      keyId.copy(header, 1);
      header[17] = type;
      const body = aeadEncrypt(dataKey, bytes, header);
      return new mongo.Binary(Buffer.concat([header, body]), ENCRYPTED_SUBTYPE);
    });
  } finally {
    bytes.fill(0);
  }
}

/**
 * Decrypts a stored value. Throws `EncryptedValueFormatError` for a value that isn't encrypted,
 * `DecryptionFailedError` when it was altered, and the key vault errors (`DataKeyNotFoundError`,
 * `EncryptionKeyMismatchError`) when its key is missing or the master key changed. None of the
 * errors includes the value.
 *
 * Only for services that need the full value. A screen shows the masked value and fetches the full
 * one through `revealSensitive`, which is access-checked and audit-logged.
 */
export async function decryptSensitive(value: unknown): Promise<SensitivePlaintext> {
  if (!isEncryptedValue(value)) throw new EncryptedValueFormatError();
  const bytes = bytesOf(value) as Buffer;
  const header = bytes.subarray(0, HEADER_BYTES);
  const keyId = Buffer.from(bytes.subarray(1, 17));
  const type = bytes[17] as number;
  const plaintext = await withDataKey(keyId, (dataKey) =>
    aeadDecrypt(dataKey, bytes.subarray(HEADER_BYTES), header),
  );
  return decodePlaintext(type, plaintext);
}

/**
 * The schema type for a sensitive field. It stores an {@link EncryptedValue} and refuses anything
 * else: Mongoose would otherwise cast a plaintext string to bytes and save it readable. The setter
 * swaps such a value for an empty one straight away, so the plaintext never reaches the database
 * or the validation error (Mongoose errors carry the rejected value), and validation then fails.
 * Every other write path (query updates, bulkWrite, lean insertMany, save without validation) is
 * checked by the write guard in guard.ts, which the first call registers.
 *
 * Supported shapes: a top-level field, a field of a nested object, or a field of a subdocument or
 * an array of subdocuments. An array of sensitive values (`[sensitiveField()]`), a Map of them, and
 * any discriminator involving a sensitive field throw SensitiveFieldShapeError when the model or
 * discriminator is defined, because their writes can't all be checked.
 *
 * The field is left out of query results unless selected (`.select('+salary')`), so a list never
 * loads it by accident.
 *
 * ```ts
 * const schema = new Schema({ bankAccountNumber: sensitiveField({ required: true }) });
 * await Employee.create({ bankAccountNumber: await encryptSensitive(input.bankAccountNumber) });
 * ```
 */
export function sensitiveField(
  options: { required?: boolean } = {},
): SchemaTypeOptions<Buffer> & { subtype: number; [SENSITIVE_OPTION]: true } {
  registerSensitiveFieldGuard();
  return {
    [SENSITIVE_OPTION]: true,
    type: Buffer,
    subtype: ENCRYPTED_SUBTYPE,
    required: options.required ?? false,
    select: false,
    set: (value: unknown) =>
      value == null || isEncryptedValue(value)
        ? value
        : new mongo.Binary(Buffer.alloc(0), ENCRYPTED_SUBTYPE),
    validate: {
      validator: (value: unknown) => value == null || isEncryptedValue(value),
      message: 'A sensitive field must be encrypted with encryptSensitive before it is saved.',
    },
  };
}
