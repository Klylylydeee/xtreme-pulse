// The local master key for field encryption (docs/adr/0005-field-level-encryption.md,
// SECURITY.md#secrets). It comes only from the FIELD_ENCRYPTION_LOCAL_KEY environment variable:
// 96 random bytes, base64-encoded, the size MongoDB's "local" key provider uses. It only wraps
// (encrypts) the data keys in the key vault; the data keys encrypt the fields.
//
// The value is never logged, returned, cached outside this call or put in an error message.

/** The environment variable that holds the master key. */
export const MASTER_KEY_ENV = 'FIELD_ENCRYPTION_LOCAL_KEY';
/** The master key's length in bytes, before base64. */
export const MASTER_KEY_BYTES = 96;

const HOW_TO_SET = `Add it to .env.local at the repo root (see .env.example and docs/DEPLOYMENT.md#environment-variables), then restart the app.`;

/** Thrown when FIELD_ENCRYPTION_LOCAL_KEY is not set. */
export class EncryptionNotConfiguredError extends Error {
  constructor() {
    super(
      `${MASTER_KEY_ENV} is not set, so sensitive fields can't be encrypted or read. ${HOW_TO_SET}`,
    );
    this.name = 'EncryptionNotConfiguredError';
  }
}

/** Thrown when FIELD_ENCRYPTION_LOCAL_KEY is set but is not 96 bytes of base64. Never shows the value. */
export class EncryptionKeyInvalidError extends Error {
  constructor() {
    super(
      `${MASTER_KEY_ENV} must be ${MASTER_KEY_BYTES} random bytes, base64-encoded (${(MASTER_KEY_BYTES / 3) * 4} characters). The value that is set isn't. ${HOW_TO_SET}`,
    );
    this.name = 'EncryptionKeyInvalidError';
  }
}

// Standard base64 with padding. 96 bytes always encode to 128 characters without padding.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** True when FIELD_ENCRYPTION_LOCAL_KEY is set (valid or not). Never exposes the value. */
export function isEncryptionConfigured(): boolean {
  return Boolean(process.env[MASTER_KEY_ENV]?.trim());
}

/**
 * Decodes the master key from the environment into a new buffer, which the caller must wipe
 * (`fill(0)`) when done. Throws {@link EncryptionNotConfiguredError} or
 * {@link EncryptionKeyInvalidError}. Read on every use, so a changed value is never served from a
 * stale copy.
 */
export function readMasterKey(): Buffer {
  const text = process.env[MASTER_KEY_ENV]?.trim();
  if (!text) throw new EncryptionNotConfiguredError();
  if (text.length % 4 !== 0 || !BASE64.test(text)) throw new EncryptionKeyInvalidError();
  const key = Buffer.from(text, 'base64');
  if (key.length !== MASTER_KEY_BYTES) {
    key.fill(0);
    throw new EncryptionKeyInvalidError();
  }
  return key;
}
